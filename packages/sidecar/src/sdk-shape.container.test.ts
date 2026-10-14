// T2: contract between the fake SDK in @deskmates/testkit and the real `@anthropic-ai/claude-agent-sdk`
// (ADR-0002 verification row 1; test strategy §4.3 last item).
//
// Part 1 is compile-time and runs on every `tsc -b`: every message type the fake emits is
// assignable to the real SDK type, the real `Options` is assignable to what the fake accepts, and
// the fake's `query`/`tool`/`createSdkMcpServer` fit the sidecar's `SidecarDeps` slots without a
// cast. Part 2 calls the real SDK once with `maxTurns: 1` and is skipped unless MODEL_BASE_URL,
// MODEL_AUTH_TOKEN and DEFAULT_MODEL are set. Part 3 needs no model: it starts the real SDK against
// a local scripted upstream with the skill options the sidecar builds (ADR-0015 decision 1) and
// reads what the SDK itself enabled.

import type {
  CanUseTool,
  HookCallback,
  Options,
  PostModelSwitchHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type RunSkill, SKILL_PLUGIN_NAME } from "@deskmates/contracts";
import type {
  FakeSdk,
  SdkApiRetryMessage,
  SdkAssistantMessage,
  SdkCanUseTool,
  SdkCompactBoundaryMessage,
  SdkHookCallback,
  SdkMessage,
  SdkPostModelSwitchHookCallback,
  SdkPostModelSwitchHookInput,
  SdkPreCompactHookCallback,
  SdkPreCompactHookInput,
  SdkPreToolUseHookInput,
  SdkQueryOptions,
  SdkResultMessage,
  SdkSystemInitMessage,
  SdkUserMessage,
} from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { CreateSdkMcpServerFn, QueryFn, ToolFn } from "./deps.js";
import { type SkillPlugin, materializeSkillPlugin } from "./skill-plugin.js";
import type { AssistantUsageMessage } from "./turn-usage.js";

type Assignable<From, To> = [From] extends [To] ? true : false;
type Assert<T extends true> = T;

// Messages the fake emits are real SDK messages.
type _init = Assert<Assignable<SdkSystemInitMessage, SDKSystemMessage>>;
type _assistant = Assert<Assignable<SdkAssistantMessage, SDKAssistantMessage>>;
type _user = Assert<Assignable<SdkUserMessage, SDKUserMessage>>;
type _result = Assert<Assignable<SdkResultMessage, SDKResultMessage>>;
type _any = Assert<Assignable<SdkMessage, SDKMessage>>;
type _compact = Assert<Assignable<SdkCompactBoundaryMessage, SDKCompactBoundaryMessage>>;
// ADR-0023 decision 3: retries and model switches as the sidecar forwards them to the ledger.
type _apiRetry = Assert<Assignable<SdkApiRetryMessage, SDKAPIRetryMessage>>;
type _postModelSwitchInput = Assert<
  Assignable<SdkPostModelSwitchHookInput, PostModelSwitchHookInput>
>;
type _postModelSwitchHook = Assert<Assignable<HookCallback, SdkPostModelSwitchHookCallback>>;
// `fallbackModel` is one comma-separated string in 0.3.278; the sidecar passes FALLBACK_MODEL as is.
type _fallbackModel = Assert<Assignable<Options["fallbackModel"], string | undefined>>;

// What the sidecar reads for the context ledger (M3 context plan, Phase 1) is there in 0.3.278:
// per-response usage on every assistant message, and trigger / pre_tokens / optional post_tokens
// on the compaction boundary.
type _turnUsage = Assert<Assignable<SDKAssistantMessage, AssistantUsageMessage>>;
type _compactMetadata = Assert<
  Assignable<
    SDKCompactBoundaryMessage["compact_metadata"],
    { trigger: "manual" | "auto"; pre_tokens: number; post_tokens?: number }
  >
>;

// The real options fit what the fake accepts, so sidecar code typed against `Options` drives it.
type _options = Assert<Assignable<Options, SdkQueryOptions>>;
type _hook = Assert<Assignable<HookCallback, SdkHookCallback>>;
type _hookInput = Assert<Assignable<SdkPreToolUseHookInput, PreToolUseHookInput>>;
type _preCompactHook = Assert<Assignable<HookCallback, SdkPreCompactHookCallback>>;
type _preCompactInput = Assert<Assignable<SdkPreCompactHookInput, PreCompactHookInput>>;
type _canUseTool = Assert<Assignable<CanUseTool, SdkCanUseTool>>;

// ADR-0015 decision 1: the skill plugin and list the sidecar builds are the SDK's own option types.
type _plugins = Assert<Assignable<SkillPlugin["plugin"], NonNullable<Options["plugins"]>[number]>>;
type _skills = Assert<Assignable<SkillPlugin["skills"], NonNullable<Options["skills"]>>>;

// The fake plugs into SidecarDeps without casts.
type _query = Assert<Assignable<FakeSdk["query"], QueryFn>>;
type _tool = Assert<Assignable<FakeSdk["tool"], ToolFn>>;
type _server = Assert<Assignable<FakeSdk["createSdkMcpServer"], CreateSdkMcpServerFn>>;

const MODEL_BASE_URL = process.env.MODEL_BASE_URL ?? "";
const MODEL_AUTH_TOKEN = process.env.MODEL_AUTH_TOKEN ?? "";
const MODEL = process.env.DEFAULT_MODEL ?? "";
const live = MODEL_BASE_URL !== "" && MODEL_AUTH_TOKEN !== "" && MODEL !== "";

describe("fake SDK shapes are assignable to the real SDK (compile-time)", () => {
  it("compiles", () => {
    expect(true).toBe(true);
  });
});

describe.skipIf(!live)("real SDK call shape (maxTurns: 1, cheapest model)", () => {
  it("calls the PreToolUse hook and canUseTool with the shapes the sidecar relies on", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "deskmates-sdk-shape-"));

    const hookInputs: PreToolUseHookInput[] = [];
    const callbackCalls: { toolName: string; hasSignal: boolean; toolUseID: string }[] = [];
    const messages: SDKMessage[] = [];
    for await (const msg of query({
      prompt: "Run the shell command: echo ok ; then reply with the single word DONE.",
      options: {
        model: MODEL,
        cwd,
        settingSources: [],
        maxTurns: 2,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: MODEL_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: MODEL_AUTH_TOKEN,
          CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                async (input) => {
                  if (input.hook_event_name === "PreToolUse") hookInputs.push(input);
                  return { hookSpecificOutput: { hookEventName: "PreToolUse" } };
                },
              ],
            },
          ],
        },
        canUseTool: async (toolName, input, { signal, toolUseID }) => {
          callbackCalls.push({ toolName, hasSignal: signal instanceof AbortSignal, toolUseID });
          return { behavior: "allow", updatedInput: input };
        },
      },
    })) {
      messages.push(msg);
    }

    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    expect(init).toBeDefined();
    const result = messages.find((m) => m.type === "result");
    if (!result || result.type !== "result") throw new Error("no result message");
    expect(typeof result.session_id).toBe("string");
    expect(typeof result.num_turns).toBe("number");
    expect(result.modelUsage).toBeTypeOf("object");
    // Every assistant message carries the response id and usage `turn-usage.ts` reads.
    const assistants = messages.filter((m) => m.type === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const m of assistants) {
      if (m.type !== "assistant") continue;
      expect(typeof m.message.id).toBe("string");
      expect(typeof m.message.usage.input_tokens).toBe("number");
      expect(typeof m.message.usage.output_tokens).toBe("number");
    }
    expect(hookInputs[0]?.tool_name).toBe("Bash");
    expect(typeof (hookInputs[0]?.tool_input as { command?: unknown })?.command).toBe("string");
    expect(callbackCalls[0]).toMatchObject({ toolName: "Bash", hasSignal: true });
    expect(hookInputs[0]?.tool_use_id).toBe(callbackCalls[0]?.toolUseID);
  });
});

/** A skill directory in the Agent Skills format, as the Gateway sends it in `StartRunRequest`. */
function runSkill(name: string, description: string): RunSkill {
  return {
    skillId: `skill_${name}`,
    name,
    version: 1,
    sha256: "a".repeat(64),
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: ${description}\n---\n\nSKILL_BODY steps for ${name}.\n`,
      },
    ],
  };
}

/** A SKILL.md the run must not get, written straight to disk. */
function rogueSkill(name: string): string {
  return `---\nname: ${name}\ndescription: ROGUE_SKILL ${name}\n---\n\nROGUE_BODY ${name}\n`;
}

type ScriptedTurn = { text: string } | { tool: string; input: Record<string, unknown> };

/**
 * Just enough of the Messages API for the CLI to finish its turns, so the case needs no model.
 * `script` answers the nth request that declares tools; anything else gets text. Every request
 * body is kept: the skill listing and the tool results the CLI sends the model are in it.
 */
async function startScriptedUpstream(script: (n: number) => ScriptedTurn): Promise<{
  url: string;
  bodies: string[];
  close(): Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const bodies: string[] = [];
  let toolTurns = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: { model?: unknown; stream?: unknown; tools?: unknown } = {};
      try {
        body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
      } catch {
        body = {};
      }
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "POST" || path !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "" } }));
        return;
      }
      bodies.push(raw);
      const declaresTools = Array.isArray(body.tools) && body.tools.length > 0;
      const turn: ScriptedTurn = declaresTools ? script(++toolTurns) : { text: "" };
      const id = `msg_skills_${bodies.length}`;
      const block =
        "text" in turn
          ? { type: "text", text: turn.text }
          : { type: "tool_use", id: `toolu_skills_${bodies.length}`, name: turn.tool, input: {} };
      const stopReason = "text" in turn ? "end_turn" : "tool_use";
      const usage = { input_tokens: 5, output_tokens: 2 };
      const model = typeof body.model === "string" ? body.model : "unknown";
      if (body.stream !== true) {
        const content = "text" in turn ? [block] : [{ ...block, input: turn.input }];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            type: "message",
            role: "assistant",
            model,
            content,
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
        content_block: "text" in turn ? { type: "text", text: "" } : block,
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
    bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** The names under the CLI's "skills are available for use with the Skill tool" listing. */
function listedSkills(body: string): string[] {
  const text = JSON.stringify(JSON.parse(body).messages ?? []);
  const header = "The following skills are available for use with the Skill tool:\\n\\n";
  const start = text.indexOf(header);
  if (start < 0) return [];
  const block = text.slice(start + header.length).split("\\n\\n")[0] ?? "";
  return block
    .split("\\n")
    .filter((line) => line.startsWith("- ") && line.includes(": "))
    .map((line) => line.slice(2, line.indexOf(": ")));
}

/** The `tool_result` block a request carries for one tool call, if any. */
function toolResult(body: string, toolUseId: string): Record<string, unknown> | undefined {
  const messages = (JSON.parse(body) as { messages?: { content?: unknown }[] }).messages ?? [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) return block;
    }
  }
  return undefined;
}

// ADR-0015 Verification row 1, T2 half. Never skipped: a loopback upstream stands in for the
// model, so no model variable is needed and none is read. Like part 2 it runs the SDK installed
// for this host (its platform build of the pinned version), not the one in the workspace image.
describe("real SDK skill set (no model; loopback scripted upstream)", () => {
  it("offers exactly the run's enabled skills from one local plugin, nothing from the bot's home", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { realFs } = await import("./real-deps.js");
    const root = mkdtempSync(join(tmpdir(), "deskmates-sdk-skills-"));
    const home = join(root, "home", "skillbot");
    const work = join(root, "work");
    await realFs.mkdir(work);

    // The run's skill set, written by the sidecar's own code into one local plugin.
    const enabled = [
      runSkill("export-refunds", "ENABLED_SKILL Export the refund sheet."),
      runSkill("close-ticket", "ENABLED_SKILL Close a ticket with a summary."),
    ];
    const skillPlugin = await materializeSkillPlugin(enabled, realFs, join(root, "plugin"));
    const qualified = (name: string) => `${SKILL_PLUGIN_NAME}:${name}`;
    expect(skillPlugin.skills).toEqual([qualified("export-refunds"), qualified("close-ticket")]);
    // Skills the run must not get: the bot's home `skills/` (design §3.1), the CLI's user and
    // project skill directories for this home and cwd, and one more skill inside the plugin
    // directory that the `skills` list does not name.
    for (const [path, name] of [
      [join(home, "skills", "rogue-home", "SKILL.md"), "rogue-home"],
      [join(home, ".claude", "skills", "rogue-user", "SKILL.md"), "rogue-user"],
      [join(work, ".claude", "skills", "rogue-project", "SKILL.md"), "rogue-project"],
      [join(skillPlugin.dir, "skills", "rogue-plugin", "SKILL.md"), "rogue-plugin"],
    ] as const) {
      await realFs.writeFile(path, rogueSkill(name));
    }

    // The scripted "model" asks for the unlisted plugin skill, then an enabled one, then stops.
    const upstream = await startScriptedUpstream((n) =>
      n === 1
        ? { tool: "Skill", input: { skill: qualified("rogue-plugin") } }
        : n === 2
          ? { tool: "Skill", input: { skill: qualified("export-refunds") } }
          : { text: "SKILLS_OK" },
    );
    const messages: SDKMessage[] = [];
    try {
      for await (const msg of query({
        prompt: "Use the export-refunds skill.",
        options: {
          model: "fake-sdk-shape-skills",
          cwd: work,
          // As the sidecar starts every run (run-once.ts).
          settingSources: [],
          plugins: [skillPlugin.plugin],
          skills: skillPlugin.skills,
          maxTurns: 4,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            ANTHROPIC_BASE_URL: upstream.url,
            ANTHROPIC_AUTH_TOKEN: "sdk-shape-skills-fake",
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_ERROR_REPORTING: "1",
            DISABLE_AUTOUPDATER: "1",
          },
          // The sidecar's backstop allows what its hook allowed; the subject here is the filter.
          canUseTool: async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
        },
      })) {
        messages.push(msg);
      }
    } finally {
      await upstream.close();
    }
    const result = messages.find((m) => m.type === "result");
    expect(result?.type === "result" && result.subtype).toBe("success");

    // The SDK loaded one plugin, the run's.
    const init = messages.find(
      (m): m is SDKSystemMessage => m.type === "system" && m.subtype === "init",
    );
    if (!init) throw new Error("no init message");
    expect(init.plugins.map((p) => [p.name, p.path])).toEqual([
      [SKILL_PLUGIN_NAME, skillPlugin.dir],
    ]);
    // `init.skills` is what the CLI discovered, not what it enables: it also names the CLI's
    // bundled skills and the unlisted plugin skill. Nothing from the bot's home, the user or the
    // project directory is discovered at all with `settingSources: []`.
    expect(init.skills).toEqual(expect.arrayContaining(skillPlugin.skills));
    for (const name of ["rogue-home", "rogue-user", "rogue-project"]) {
      expect(init.skills.some((skill) => skill.includes(name))).toBe(false);
    }

    // What the model is offered: exactly the run's set, by its plugin-qualified names, and no
    // other skill's description, on every request.
    const [first, second, third] = upstream.bodies;
    if (!first || !second || !third)
      throw new Error(`expected 3 requests, got ${upstream.bodies.length}`);
    expect([...listedSkills(first)].sort()).toEqual([...skillPlugin.skills].sort());
    for (const body of upstream.bodies) expect(body).not.toContain("ROGUE_SKILL");
    // The Skill tool refuses the unlisted one without loading it, and loads an enabled one.
    const refused = toolResult(second, "toolu_skills_1");
    expect(refused?.is_error).toBe(true);
    expect(JSON.stringify(refused?.content)).toContain("is not in this session's skills allowlist");
    expect(toolResult(third, "toolu_skills_2")?.is_error).not.toBe(true);
    expect(upstream.bodies.some((body) => body.includes("ROGUE_BODY"))).toBe(false);
    expect(third).toContain("SKILL_BODY steps for export-refunds.");
    await realFs.rm(root);
  });

  const categories = ["research", "data", "browser", "collaboration", "meta"] as const;
  it.each(categories)("loads one release-bundled %s Skill body on demand", async (category) => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { realFs } = await import("./real-deps.js");
    const catalogRoot = fileURLToPath(new URL("../../gateway/starter-skills/", import.meta.url));
    const manifest = JSON.parse(readFileSync(join(catalogRoot, "manifest.json"), "utf8")) as {
      skills: { name: string; category: string; version: number; sha256: string }[];
    };
    const entry = manifest.skills.find((candidate) => candidate.category === category);
    if (!entry) throw new Error(`no Starter Skill for ${category}`);
    const content = readFileSync(join(catalogRoot, entry.name, "SKILL.md"), "utf8");
    const bodyMarker = content.split("---\n\n")[1]?.split("\n")[0];
    if (!bodyMarker) throw new Error(`Starter Skill ${entry.name} has no body marker`);
    const skill: RunSkill = {
      skillId: `starter:${entry.name}`,
      name: entry.name,
      version: entry.version,
      sha256: entry.sha256,
      files: [{ path: "SKILL.md", content }],
    };
    const root = mkdtempSync(join(tmpdir(), `deskmates-starter-${category}-`));
    const home = join(root, "home");
    const work = join(root, "work");
    await realFs.mkdir(work);
    const plugin = await materializeSkillPlugin([skill], realFs, join(root, "plugin"));
    const qualified = `${SKILL_PLUGIN_NAME}:${entry.name}`;
    const upstream = await startScriptedUpstream((n) =>
      n === 1 ? { tool: "Skill", input: { skill: qualified } } : { text: "STARTER_OK" },
    );
    const messages: SDKMessage[] = [];
    try {
      for await (const message of query({
        prompt: `Use ${entry.name}.`,
        options: {
          model: "fake-sdk-shape-starter",
          cwd: work,
          settingSources: [],
          plugins: [plugin.plugin],
          skills: plugin.skills,
          maxTurns: 3,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            ANTHROPIC_BASE_URL: upstream.url,
            ANTHROPIC_AUTH_TOKEN: "sdk-shape-starter-fake",
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_ERROR_REPORTING: "1",
            DISABLE_AUTOUPDATER: "1",
          },
          canUseTool: async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
        },
      }))
        messages.push(message);
    } finally {
      await upstream.close();
    }
    const [beforeUse, afterUse] = upstream.bodies;
    if (!beforeUse || !afterUse) throw new Error("Starter Skill smoke did not reach two turns");
    expect(listedSkills(beforeUse)).toEqual([qualified]);
    expect(beforeUse).not.toContain(bodyMarker);
    expect(afterUse).toContain(bodyMarker);
    expect(messages.find((message) => message.type === "result")).toMatchObject({
      type: "result",
      subtype: "success",
    });
    await realFs.rm(root);
  });
});
