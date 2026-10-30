// T1: what a run records about the CLI's own context (ADR-0023 amendment 5, decisions 20 and
// 21). One `full` `getContextUsage` sample after init, one `summary` sample per model response,
// and the `SessionStart` hook's resume facts, each a `log` event. A CLI that cannot answer costs
// one warning and nothing else. The fake SDK stands in for the real one.

import type {
  BotId,
  RunId,
  SidecarEvent,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import {
  type FakeSdkConfig,
  type ScriptStep,
  createFakeSdk,
  defaultContextUsage,
} from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import { contextUsagePayload } from "./context-usage.js";
import type { SidecarDeps } from "./deps.js";
import { runOnce } from "./run-once.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const TOKEN = "deskmates-run-token-context-usage-7b2c";
const HOME = "/home/nova";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-ctx" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    botRole: "ops bot",
    workspaceId: "ws-1" as WorkspaceId,
    workspaceName: "Ops",
    threadId: "thread-1" as ThreadId,
    botHomeDir: HOME,
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
          body: "Write the note",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test",
    modelAuthToken: TOKEN,
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: [],
    connectors: [],
    tools: ["thread_post"],
    ...overrides,
  };
}

const summary = (reply: string) =>
  `${reply}\n\`\`\`json\n${JSON.stringify({
    done: reply,
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  })}\n\`\`\``;

const THREE_TURNS: ScriptStep[] = [
  { type: "text", text: "one", usage: { inputTokens: 100, outputTokens: 5 } },
  { type: "text", text: "two", usage: { inputTokens: 120, outputTokens: 5 } },
  { type: "text", text: "three", usage: { inputTokens: 140, outputTokens: 5 } },
  { type: "end", summary: summary("done") },
];

async function play(
  script: ScriptStep[],
  config: FakeSdkConfig = {},
  overrides: Partial<StartRunRequest> = {},
  sdk = createFakeSdk(script, config),
) {
  const gateway = createFakeGateway({ egressAllowlist: () => [] });
  let clock = Date.parse("2026-10-16T10:00:00Z");
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: gateway.fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  const ended = await runOnce(request(overrides), deps, { approvalPollMs: 1, batchDelayMs: 1 });
  const logs = (kind: string) =>
    gateway.events.filter((e): e is SidecarEvent => e.kind === "log" && e.payload.kind === kind);
  return { ended, gateway, sdk, logs };
}

describe("context usage samples (ADR-0023 amendment 5, decision 20)", () => {
  it("takes one full sample after init and a summary after each response but the last", async () => {
    const { ended, sdk, logs } = await play(THREE_TURNS);
    expect(ended.outcome).toBe("completed");
    // The last response's usage is ledgered with the result, when the CLI is about to exit, so
    // no sample is asked for then.
    expect(sdk.contextUsageCalls).toEqual([
      { detail: "full" },
      { detail: "summary" },
      { detail: "summary" },
    ]);
    const samples = logs("context_usage").map((e) => e.payload);
    expect(samples.map((p) => [p.detail, p.turn])).toEqual([
      ["full", 0],
      ["summary", 1],
      ["summary", 2],
    ]);
    expect(samples[0]).toMatchObject({
      source: "context",
      totalTokens: 21500,
      maxTokens: 200000,
      model: "model-under-test",
      mcpTools: { count: 2, tokens: 6000, byServer: { browser: 4000, deskmates: 2000 } },
      systemTools: { count: 2, tokens: 12000 },
    });
  });

  it("names every tool on a full sample and only totals on a summary", () => {
    const report = defaultContextUsage("m");
    const full = contextUsagePayload(report, "full", 0);
    const brief = contextUsagePayload(report, "summary", 3);
    expect(full.systemTools).toEqual({
      count: 2,
      tokens: 12000,
      tools: [
        { name: "Bash", tokens: 9000 },
        { name: "Read", tokens: 3000 },
      ],
    });
    expect(brief.systemTools).toEqual({ count: 2, tokens: 12000 });
    expect(brief.mcpTools).toEqual({
      count: 2,
      tokens: 6000,
      byServer: { browser: 4000, deskmates: 2000 },
    });
    expect(full.categories).toContainEqual({ name: "Free space", kind: "free", tokens: 178500 });
  });

  it("logs one warning and asks no more when the CLI cannot answer, and the run completes", async () => {
    const { ended, sdk, logs } = await play(THREE_TURNS, {
      contextUsage: () => {
        throw new Error("control request unsupported");
      },
    });
    expect(ended.outcome).toBe("completed");
    expect(sdk.contextUsageCalls).toHaveLength(1);
    expect(logs("context_usage").map((e) => e.payload)).toEqual([
      {
        source: "context",
        kind: "context_usage",
        level: "warn",
        detail: "full",
        turn: 0,
        error: "Error: control request unsupported",
      },
    ]);
  });

  it("asks nothing of a query that has no getContextUsage", async () => {
    const sdk = createFakeSdk(THREE_TURNS);
    const { ended, logs } = await play(
      THREE_TURNS,
      {},
      {},
      {
        ...sdk,
        // The fake's query without the control method, as a plain stream of messages would be.
        query: (params) =>
          Object.assign(sdk.query(params), { getContextUsage: undefined as never }),
      },
    );
    expect(ended.outcome).toBe("completed");
    expect(sdk.contextUsageCalls).toHaveLength(0);
    expect(logs("context_usage")).toHaveLength(0);
  });
});

describe("session start facts (ADR-0023 amendment 5, decision 21)", () => {
  it("records a fresh start with no resume fields", async () => {
    const { logs } = await play(THREE_TURNS);
    expect(logs("session_start").map((e) => e.payload)).toEqual([
      { source: "sdk", kind: "session_start", sessionSource: "startup" },
    ]);
  });

  it("records the re-sent context and the cache expectation on a resume", async () => {
    const sdk = createFakeSdk(THREE_TURNS, {
      resumeFacts: {
        context_tokens: 48000,
        prompt_cache_likely_expired: true,
        seconds_since_last_response: 900,
      },
    });
    const first = await play(THREE_TURNS, {}, {}, sdk);
    const sessionId = first.ended.sdkSessionId;
    if (sessionId === undefined) throw new Error("no session id");
    const { logs } = await play(THREE_TURNS, {}, { sdkSessionId: sessionId, attempt: 2 }, sdk);
    expect(logs("session_start").map((e) => e.payload)).toEqual([
      {
        source: "sdk",
        kind: "session_start",
        sessionSource: "resume",
        contextTokens: 48000,
        promptCacheLikelyExpired: true,
        secondsSinceLastResponse: 900,
      },
    ]);
  });
});
