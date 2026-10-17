// T1: the OpenAI Agents SDK runtime inside `runOnce` (ADR-0044), against a scripted Chat
// Completions server and the fake Gateway. The real Agents SDK runs; no model does. The Claude
// SDK's `createSdkMcpServer` and `tool` build the in-process `deskmates` MCP server the runtime
// attaches; they start no CLI and call no model.

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalId,
  BotId,
  RunId,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import {
  type FakeOpenAiServer,
  type FakeOpenAiStep,
  startFakeOpenAiServer,
} from "@deskmates/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SidecarDeps } from "../../deps.js";
import { runOnce } from "../../run-once.js";
import { type FakeGatewayOptions, createFakeGateway } from "../../testing/fake-gateway.js";
import { createMemoryFs } from "../../testing/in-memory-fs.js";
import { sessionDirOf } from "./file-session.js";
import { createOpenAiQuery } from "./openai-runtime.js";

const TOKEN = "run-token-under-test";
const MODEL = "oai-model-under-test";

let home: string;
let work: string;
let fake: FakeOpenAiServer;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "deskmates-oai-home-"));
  work = await mkdtemp(join(tmpdir(), "deskmates-oai-work-"));
});

afterEach(async () => {
  await fake?.close();
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const summaryBlock = (reply: string, done = "did the thing") =>
  `${reply}\n\`\`\`json\n${JSON.stringify({
    done,
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  })}\n\`\`\``;

function baseRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-1" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    workspaceId: "ws-1" as WorkspaceId,
    threadId: "thread-1" as ThreadId,
    botHomeDir: home,
    attempt: 1,
    trigger: {
      kind: "thread_message",
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Ops" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "Check the ticket queue",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    runtime: "openai-agents",
    model: MODEL,
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: fake.baseUrl,
    modelAuthToken: TOKEN,
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 20,
    egressAllowlist: ["ops.example.test"],
    connectors: [],
    tools: ["thread_post"],
    ...overrides,
  };
}

async function makeDeps(steps: FakeOpenAiStep[], gatewayOpts: FakeGatewayOptions = {}) {
  fake = await startFakeOpenAiServer({
    steps,
    usage: (index) => ({ promptTokens: 20 + index, completionTokens: 5, cachedTokens: 4 }),
  });
  const gateway = createFakeGateway({
    egressAllowlist: () => ["ops.example.test"],
    ...gatewayOpts,
  });
  const fs = createMemoryFs({ [`${home}/SOUL.md`]: "You are Nova, the ops bot." });
  let clock = Date.parse("2026-10-16T10:00:00Z");
  const deps: SidecarDeps = {
    query: () => {
      throw new Error("the Claude SDK must not run on the openai-agents runtime");
    },
    queryOpenAi: createOpenAiQuery({
      env: { PATH: process.env.PATH },
      attachStdio: false,
      cwdOverride: work,
    }),
    tool,
    createSdkMcpServer,
    fetch: gateway.fetch,
    fs,
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    sleep: async () => {},
  };
  return { gateway, deps };
}

const run = (deps: SidecarDeps, request: StartRunRequest) =>
  runOnce(request, deps, { approvalPollMs: 1, batchDelayMs: 1 });

function toolMessages(index: number): { role: string; content: unknown; tool_call_id?: string }[] {
  return (fake.requests[index]?.messages ?? []) as {
    role: string;
    content: unknown;
    tool_call_id?: string;
  }[];
}

describe("openai-agents runtime: the loop", () => {
  it("answers, names the runtime in the ledger, offers the sidecar's tools and reports usage", async () => {
    const { gateway, deps } = await makeDeps([{ text: summaryBlock("Queue is empty.") }]);
    const ended = await run(deps, baseRequest());

    expect(ended.outcome).toBe("completed");
    expect(ended.summary?.reply).toBe("Queue is empty.");
    expect(ended.sdkSessionId).toBeDefined();
    const init = gateway.events.find((e) => e.kind === "log" && e.payload.source === "sdk");
    expect(init?.payload.cliVersion).toMatch(/^openai-agents@/);
    // One request, with the built-ins under the Claude SDK names and the deskmates MCP tools.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.model).toBe(MODEL);
    expect(fake.requests[0]?.tools).toEqual(
      expect.arrayContaining([
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "LS",
        "mcp__deskmates__thread_post",
      ]),
    );
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const system = toolMessages(0).find((m) => m.role === "system");
    expect(String(system?.content)).toContain("You are Nova");
    // Cached tokens are reported the Claude way: outside input, as cache reads.
    expect(ended.usage).toEqual([
      expect.objectContaining({
        model: MODEL,
        inputTokens: 16,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheCreateTokens: 0,
      }),
    ]);
  });

  it("runs a built-in tool through the gate and feeds its result back to the model", async () => {
    await writeFile(join(work, "queue.txt"), "ticket-1\nticket-2\n");
    const { gateway, deps } = await makeDeps([
      { toolCalls: [{ name: "Read", arguments: { file_path: join(work, "queue.txt") } }] },
      { text: summaryBlock("Two tickets.") },
    ]);
    const ended = await run(deps, baseRequest());

    expect(ended.outcome).toBe("completed");
    const call = gateway.events.find((e) => e.kind === "tool_call");
    expect(call?.payload).toMatchObject({
      toolName: "Read",
      riskLevel: "L0",
      input: { file_path: join(work, "queue.txt") },
    });
    const result = gateway.events.find((e) => e.kind === "tool_result");
    expect(result?.payload).toMatchObject({ isError: false, toolUseId: call?.payload.toolUseId });
    const toolMessage = toolMessages(1).find((m) => m.role === "tool");
    expect(String(toolMessage?.content)).toContain("1\tticket-1");
  });

  it("posts to the thread through the in-process deskmates MCP server", async () => {
    const { gateway, deps } = await makeDeps([
      { toolCalls: [{ name: "mcp__deskmates__thread_post", arguments: { body: "On it." } }] },
      { text: summaryBlock("Posted.") },
    ]);
    const ended = await run(deps, baseRequest());
    expect(ended.outcome).toBe("completed");
    const posted = gateway.requests.find((r) => r.method === "POST" && r.url.endsWith("/messages"));
    expect(posted?.body).toContain("On it.");
    expect(gateway.events.find((e) => e.kind === "tool_call")?.payload.toolName).toBe(
      "mcp__deskmates__thread_post",
    );
  });

  it("continues a session: the second run replays the first run's exchange and usage accumulates", async () => {
    const { deps } = await makeDeps([
      { text: summaryBlock("First.") },
      { text: summaryBlock("Second.") },
    ]);
    const first = await run(deps, baseRequest());
    const second = await run(
      deps,
      baseRequest({ runId: "run-2" as RunId, sdkSessionId: first.sdkSessionId ?? "" }),
    );
    expect(second.outcome).toBe("completed");
    expect(second.sdkSessionId).toBe(first.sdkSessionId);
    const replayed = toolMessages(1).filter((m) => m.role === "assistant");
    expect(JSON.stringify(replayed)).toContain("First.");
    // Cumulative over the session, as the Claude SDK reports it (ledger/usage.ts subtracts).
    expect(second.usage[0]).toMatchObject({ inputTokens: 16 + 17, outputTokens: 10 });
    expect(await readdir(sessionDirOf(home))).toEqual([`${first.sdkSessionId}.json`]);
  });
});

describe("openai-agents runtime: L2 approvals through the one hook (ADR-0044 decisions 2 and 3)", () => {
  const push = { name: "Bash", arguments: { command: "git push origin main" } };

  it("an immediate deny from the Gateway becomes the tool's error result and the run completes", async () => {
    const { gateway, deps } = await makeDeps([
      { toolCalls: [push] },
      { text: summaryBlock("Could not push.") },
    ]); // default responder: deny
    const ended = await run(deps, baseRequest());

    expect(ended.outcome).toBe("completed");
    expect(gateway.approvals).toHaveLength(1);
    expect(gateway.approvals[0]).toMatchObject({
      riskLevel: "L2",
      action: { toolName: "Bash", input: { command: "git push origin main" } },
    });
    const denied = gateway.events.find((e) => e.kind === "tool_result");
    expect(denied?.payload).toMatchObject({
      isError: true,
      content: "M0: approvals are denied automatically",
    });
    expect(String(toolMessages(1).find((m) => m.role === "tool")?.content)).toBe(
      "M0: approvals are denied automatically",
    );
  });

  it("no answer within the short wait parks the run with its state, and the human's allow resumes it", async () => {
    const { gateway, deps } = await makeDeps(
      [{ toolCalls: [push] }, { text: summaryBlock("Pushed.") }],
      { approvalResponder: () => "pending" },
    );
    const first = await run(deps, baseRequest({ shortWaitSeconds: 1 }));

    expect(first.outcome).toBe("deferred");
    expect(first.pendingApprovalId).toBe(gateway.approvals[0]?.approvalId);
    expect(first.pendingToolUseId).toBeDefined();
    const sessionId = first.sdkSessionId ?? "";
    expect((await readdir(sessionDirOf(home))).sort()).toEqual([
      `${sessionId}.json`,
      `${sessionId}.state.json`,
    ]);
    expect(fake.requests).toHaveLength(1);
    const phases = gateway.events.filter((e) => e.kind === "approval").map((e) => e.payload.phase);
    expect(phases).toEqual(["requested", "deferred"]);

    const second = await run(
      deps,
      baseRequest({
        runId: "run-2" as RunId,
        sdkSessionId: sessionId,
        shortWaitSeconds: 1,
        trigger: {
          kind: "approval",
          approvalId: first.pendingApprovalId as ApprovalId,
          decision: "allow_once",
          toolUseId: first.pendingToolUseId as string,
        },
      }),
    );
    expect(second.outcome).toBe("completed");
    expect(second.summary?.reply).toBe("Pushed.");
    expect(second.sdkSessionId).toBe(sessionId);
    // The deferred command ran exactly once, on the resumed run, without a new approval.
    expect(gateway.approvals).toHaveLength(1);
    const resumed = gateway.events.find(
      (e) => e.kind === "approval" && e.payload.phase === "resumed",
    );
    expect(resumed?.runId).toBe("run-2");
    expect(resumed?.payload).toMatchObject({ consumedBy: "replay", decision: "allow_once" });
    const results = gateway.events.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.runId).toBe("run-2");
    // The model saw the command's output (not a git repository, so an error) and answered.
    expect(fake.requests).toHaveLength(2);
    expect(String(toolMessages(1).find((m) => m.role === "tool")?.content)).toMatch(
      /git|fatal|exit/i,
    );
    expect(await readdir(sessionDirOf(home))).toEqual([`${sessionId}.json`]);
  });

  it("a human deny on resume rejects the parked call and the run completes", async () => {
    const { gateway, deps } = await makeDeps(
      [{ toolCalls: [push] }, { text: summaryBlock("Understood.") }],
      { approvalResponder: () => "pending" },
    );
    const first = await run(deps, baseRequest({ shortWaitSeconds: 1 }));
    const second = await run(
      deps,
      baseRequest({
        runId: "run-2" as RunId,
        sdkSessionId: first.sdkSessionId ?? "",
        shortWaitSeconds: 1,
        trigger: {
          kind: "approval",
          approvalId: first.pendingApprovalId as ApprovalId,
          decision: "deny",
          toolUseId: first.pendingToolUseId as string,
        },
      }),
    );
    expect(second.outcome).toBe("completed");
    expect(gateway.approvals).toHaveLength(1);
    const toolMessage = toolMessages(1).find((m) => m.role === "tool");
    expect(String(toolMessage?.content)).toMatch(/Denied by human/);
  });
});
