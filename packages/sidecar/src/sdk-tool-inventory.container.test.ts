// T2: the tool inventory of the pinned SDK against the sidecar's tier tables (ADR-0002
// amendment 3, A5 Verification row). No model: a loopback scripted upstream stands in for it, as
// in `sdk-shape.container.test.ts` part 3, and like that part it runs the SDK installed for this
// host (its platform build of the pinned version), not the one in the workspace image.
//
// 1. Every built-in tool the pinned CLI declares to the model, withheld ones included, is named by
//    a tier table, so none is L2 only by the fail-closed default. A new SDK release that adds a
//    tool fails here until someone tiers it on purpose.
// 2. `PreToolUse` fires for a tool call made inside a subagent, with `agent_id` and `agent_type`
//    set, which is why a spawn (`Agent`/`Task`) can be L1: every inner call is still judged.

import type { HookCallback, PreToolUseHookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { SDK_BUILTIN_TOOLS, classifyTool, splitMcpToolName } from "./risk-tier.js";

const INNER_MARKER = "INVENTORY_INNER_TASK";

type Turn = { text: string } | { tool: string; input: Record<string, unknown> };

/**
 * Just enough of the Messages API for the CLI's turns. Every request body is kept: the tool list
 * the CLI declares is in it. `script` sees the parsed body of each request that declares tools.
 */
async function startUpstream(script: (body: { messages?: unknown }) => Turn): Promise<{
  url: string;
  tools: Set<string>;
  close(): Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const tools = new Set<string>();
  let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: { model?: unknown; stream?: unknown; tools?: unknown; messages?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        body = {};
      }
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "" } }));
        return;
      }
      const declared = Array.isArray(body.tools) ? (body.tools as { name?: unknown }[]) : [];
      for (const t of declared) if (typeof t.name === "string") tools.add(t.name);
      const turn: Turn = declared.length > 0 ? script(body) : { text: "" };
      n += 1;
      const id = `msg_inventory_${n}`;
      const model = typeof body.model === "string" ? body.model : "unknown";
      const usage = { input_tokens: 5, output_tokens: 2 };
      const block =
        "text" in turn
          ? { type: "text", text: turn.text }
          : { type: "tool_use", id: `toolu_inventory_${n}`, name: turn.tool, input: turn.input };
      const stopReason = "text" in turn ? "end_turn" : "tool_use";
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            type: "message",
            role: "assistant",
            model,
            content: [block],
            stop_reason: stopReason,
            stop_sequence: null,
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sse("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      });
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: "text" in turn ? { type: "text", text: "" } : { ...block, input: {} },
      });
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta:
          "text" in turn
            ? { type: "text_delta", text: turn.text }
            : { type: "input_json_delta", partial_json: JSON.stringify(turn.input) },
      });
      sse("content_block_stop", { type: "content_block_stop", index: 0 });
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 2 },
      });
      sse("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("no upstream address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    tools,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("pinned SDK tool inventory (ADR-0002 amendment 3, A5; no model)", () => {
  it("names every built-in tool in a tier table, and the hook sees a subagent's inner call", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "deskmates-sdk-inventory-"));

    // Main thread: spawn one subagent, then stop. Subagent: run one Bash command, then stop.
    const upstream = await startUpstream((body) => {
      const text = JSON.stringify(body.messages ?? []);
      if (text.includes('"tool_result"')) return { text: "INVENTORY_DONE" };
      if (text.includes(INNER_MARKER))
        return { tool: "Bash", input: { command: "echo inner", description: "inner call" } };
      return {
        tool: "Agent",
        input: {
          description: "inventory probe",
          prompt: `${INNER_MARKER}: run echo inner and report`,
          subagent_type: "general-purpose",
        },
      };
    });

    const hookInputs: PreToolUseHookInput[] = [];
    const hook: HookCallback = async (input) => {
      if (input.hook_event_name === "PreToolUse") hookInputs.push(input);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    };
    const messages: SDKMessage[] = [];
    try {
      for await (const msg of query({
        prompt: "Spawn the inventory probe subagent.",
        options: {
          model: "fake-sdk-inventory",
          cwd: root,
          // As the sidecar starts every run (run-once.ts), but with no `disallowedTools`: the
          // withheld tools must be tiered too, in case one is ever offered.
          settingSources: [],
          permissionMode: "default",
          maxTurns: 6,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            ANTHROPIC_BASE_URL: upstream.url,
            ANTHROPIC_AUTH_TOKEN: "sdk-inventory-fake",
            CLAUDE_CONFIG_DIR: join(root, ".claude"),
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
          hooks: { PreToolUse: [{ hooks: [hook] }] },
          canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
        },
      })) {
        messages.push(msg);
      }
    } finally {
      await upstream.close();
    }

    // 1. The inventory: what the CLI declared to the model plus what its init message lists.
    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    const initTools = init && init.type === "system" && "tools" in init ? init.tools : [];
    const builtIns = [...new Set([...upstream.tools, ...initTools])].filter(
      (name) => splitMcpToolName(name).server === undefined,
    );
    expect(builtIns.length).toBeGreaterThan(0);
    expect(builtIns).toContain("Agent");
    const missing = builtIns.filter((name) => !SDK_BUILTIN_TOOLS.has(name)).sort();
    expect(missing, "pinned SDK tools in no tier table").toEqual([]);
    for (const name of builtIns) expect(classifyTool(name, {}).unclassified, name).toBeUndefined();
    expect(classifyTool("Agent", {}).level).toBe("L1");
    expect(classifyTool("ListAgents", {}).level).toBe("L0");

    // 2. The hook saw the spawn on the main thread and the inner call with the subagent's ids.
    const spawn = hookInputs.find((i) => i.tool_name === "Agent" || i.tool_name === "Task");
    expect(spawn).toBeDefined();
    expect(spawn?.agent_id).toBeUndefined();
    const inner = hookInputs.find((i) => i.tool_name === "Bash");
    expect(inner, "PreToolUse for the subagent's Bash call").toBeDefined();
    expect(typeof inner?.agent_id).toBe("string");
    expect(typeof inner?.agent_type).toBe("string");
  }, 120_000);
});
