// T1: the sidecar records what the SDK did with models (ADR-0023 decision 3; test plan FB-02,
// FB-03, FAULT-01..03, FAULT-09, SEC-06). `PostModelSwitch` becomes one `model_switch` event,
// every `api_retry` one `model_retry` event, `FALLBACK_MODEL` reaches `options.fallbackModel`
// verbatim, and the run's usage is reported per model actually served. The fake SDK stands in
// for the real one; the sidecar calls `query()` once and never retries a model call itself.

import type {
  BotId,
  RunId,
  SidecarEvent,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { runOnce } from "./run-once.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const TOKEN = "deskmates-run-token-model-events-5d1e";
const HOME = "/home/nova";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-models" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    workspaceId: "ws-1" as WorkspaceId,
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

async function play(script: ScriptStep[], overrides: Partial<StartRunRequest> = {}) {
  const sdk = createFakeSdk(script);
  const gateway = createFakeGateway({ egressAllowlist: () => [] });
  let clock = Date.parse("2026-10-09T10:00:00Z");
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
  const session = [...sdk.sessions.values()][0];
  if (!session) throw new Error("no SDK session");
  const of = (kind: SidecarEvent["kind"]) => gateway.events.filter((e) => e.kind === kind);
  return { ended, gateway, session, of };
}

describe("FALLBACK_MODEL reaches the SDK verbatim", () => {
  it("sets options.fallbackModel when the request carries one", async () => {
    const { session } = await play([{ type: "end", summary: summary("ok") }], {
      fallbackModel: "fallback-under-test",
    });
    expect(session.calls[0]?.options?.fallbackModel).toBe("fallback-under-test");
  });

  it("leaves the option out entirely when the request has none", async () => {
    const { session } = await play([{ type: "end", summary: summary("ok") }]);
    expect(session.calls[0]?.options).toBeDefined();
    expect("fallbackModel" in (session.calls[0]?.options ?? {})).toBe(false);
  });
});

describe("model switches (FB-02, FAULT-01, FAULT-09)", () => {
  it("FB-02: one model_switch per switch, with from, to and source, and usage per model", async () => {
    const { ended, of } = await play(
      [
        { type: "text", text: "on primary", usage: { inputTokens: 40, outputTokens: 4 } },
        { type: "model_switch", source: "auto" },
        { type: "text", text: "on fallback", usage: { inputTokens: 9, outputTokens: 2 } },
        { type: "end", summary: summary("done") },
      ],
      { fallbackModel: "fallback-under-test" },
    );
    expect(of("model_switch").map((e) => e.payload)).toEqual([
      {
        from: "model-under-test",
        to: "fallback-under-test",
        source: "auto",
        requested: "fallback-under-test",
        // ADR-0023 amendment 5: the hook's cache facts ride along.
        promptCacheWarm: false,
        contextTokens: 0,
      },
    ]);
    expect(ended.outcome).toBe("completed");
    expect(ended.usage.map((u) => [u.model, u.inputTokens, u.outputTokens]).sort()).toEqual([
      ["fallback-under-test", 9, 2],
      ["model-under-test", 40, 4],
    ]);
  });

  it("FAULT-01: an overloaded primary retried then switched records both, and the tool runs once", async () => {
    const { ended, session, of } = await play(
      [
        {
          type: "tool_call",
          name: "Read",
          input: { file_path: "/work/notes.md" },
          result: "notes",
        },
        { type: "api_retry", attempt: 1, errorStatus: 529, error: "overloaded" },
        { type: "api_retry", attempt: 2, errorStatus: 529, error: "overloaded" },
        // SDK 0.3.278's own signal for an overload fallback: a message, not the hook.
        { type: "model_fallback" },
        { type: "text", text: "answered on the fallback" },
        { type: "end", summary: summary("done") },
      ],
      { fallbackModel: "fallback-under-test" },
    );
    // FAULT-09: the tool's effect happened once, before the switch; the switch replays nothing.
    expect(session.toolCalls.filter((c) => c.executed)).toHaveLength(1);
    expect(of("tool_call")).toHaveLength(1);
    expect(of("tool_result")).toHaveLength(1);
    expect(of("model_retry").map((e) => e.payload.errorStatus)).toEqual([529, 529]);
    expect(of("model_switch")).toHaveLength(1);
    expect(new Set(ended.usage.map((u) => u.model))).toEqual(
      new Set(["model-under-test", "fallback-under-test"]),
    );
    // The switch is recorded after the retries that led to it, in ledger order.
    const order = of("model_retry")
      .concat(of("model_switch"))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.kind);
    expect(order).toEqual(["model_retry", "model_retry", "model_switch"]);
  });

  it("records SDK 0.3.278's system/model_fallback, which comes without the hook, as one auto switch", async () => {
    const { ended, of } = await play(
      [
        { type: "text", text: "on primary", usage: { inputTokens: 40, outputTokens: 4 } },
        { type: "model_fallback" },
        { type: "text", text: "on fallback", usage: { inputTokens: 9, outputTokens: 2 } },
        { type: "end", summary: summary("done") },
      ],
      { fallbackModel: "fallback-under-test" },
    );
    expect(of("model_switch").map((e) => e.payload)).toEqual([
      { from: "model-under-test", to: "fallback-under-test", source: "auto" },
    ]);
    expect(ended.outcome).toBe("completed");
  });

  it("records a switch once when the hook and the fallback message both report it", async () => {
    for (const hook of ["before", "after"] as const) {
      const { of } = await play(
        [
          { type: "text", text: "on primary" },
          { type: "model_fallback", hook },
          { type: "text", text: "on fallback" },
          { type: "end", summary: summary("done") },
        ],
        { fallbackModel: "fallback-under-test" },
      );
      expect(of("model_switch"), `hook ${hook}`).toHaveLength(1);
      expect(of("model_switch")[0]?.payload).toMatchObject({
        from: "model-under-test",
        to: "fallback-under-test",
        source: "auto",
      });
    }
  });

  it("records each of two different switches, and the same pair again in a later turn", async () => {
    const { of } = await play([
      { type: "text", text: "on primary" },
      { type: "model_fallback", to: "fallback-under-test" },
      { type: "text", text: "on fallback" },
      { type: "model_switch", to: "model-under-test", source: "sdk", requested: null },
      { type: "text", text: "back on primary" },
      { type: "model_fallback", to: "fallback-under-test" },
      { type: "text", text: "on fallback again" },
      { type: "end", summary: summary("done") },
    ]);
    expect(of("model_switch").map((e) => [e.payload.from, e.payload.to, e.payload.source])).toEqual(
      [
        ["model-under-test", "fallback-under-test", "auto"],
        ["fallback-under-test", "model-under-test", "sdk"],
        ["model-under-test", "fallback-under-test", "auto"],
      ],
    );
  });

  it("records a resume switch the same way", async () => {
    const { of } = await play([
      { type: "model_switch", to: "restored-model", source: "resume", requested: null },
      { type: "end", summary: summary("ok") },
    ]);
    expect(of("model_switch").map((e) => e.payload)).toEqual([
      {
        from: "model-under-test",
        to: "restored-model",
        source: "resume",
        requested: null,
        promptCacheWarm: false,
        contextTokens: 0,
      },
    ]);
  });
});

describe("retries (FB-03, FAULT-02, FAULT-03)", () => {
  it("FB-03: three api_retry messages are three model_retry events and the run succeeds", async () => {
    const { ended, session, of } = await play([
      {
        type: "api_retry",
        attempt: 1,
        errorStatus: 500,
        error: "server_error",
        retryDelayMs: 1000,
      },
      {
        type: "api_retry",
        attempt: 2,
        errorStatus: 502,
        error: "server_error",
        retryDelayMs: 2000,
      },
      { type: "api_retry", attempt: 3, errorStatus: null, error: "unknown", retryDelayMs: 4000 },
      { type: "text", text: "made it" },
      { type: "end", summary: summary("done") },
    ]);
    expect(of("model_retry").map((e) => e.payload)).toEqual([
      { attempt: 1, maxRetries: 10, retryDelayMs: 1000, errorStatus: 500, error: "server_error" },
      { attempt: 2, maxRetries: 10, retryDelayMs: 2000, errorStatus: 502, error: "server_error" },
      { attempt: 3, maxRetries: 10, retryDelayMs: 4000, errorStatus: null, error: "unknown" },
    ]);
    expect(ended.outcome).toBe("completed");
    // The SDK is the only retry owner: the sidecar asked it once.
    expect(session.calls).toHaveLength(1);
  });

  it("FAULT-02: retries on 429 with no fallback configured leave no switch", async () => {
    const { of } = await play([
      { type: "api_retry", attempt: 1, errorStatus: 429, error: "rate_limit" },
      { type: "text", text: "ok" },
      { type: "end", summary: summary("ok") },
    ]);
    expect(of("model_retry")).toHaveLength(1);
    expect(of("model_switch")).toHaveLength(0);
  });

  it("FAULT-03: retries exhausted fail the run with the upstream error, without a second query", async () => {
    const { ended, session, of } = await play([
      { type: "api_retry", attempt: 1, errorStatus: 503, error: "server_error" },
      { type: "api_retry", attempt: 2, errorStatus: 503, error: "server_error" },
      { type: "fail", errors: ["API Error: 503 upstream unavailable"] },
    ]);
    expect(of("model_retry")).toHaveLength(2);
    expect(ended.outcome).toBe("failed");
    expect(ended.error).toContain("503 upstream unavailable");
    expect(session.calls).toHaveLength(1);
  });
});

describe("SEC-06: the new events carry no token or prompt text", () => {
  it("redacts the run token from a switch and a retry", async () => {
    const { gateway } = await play(
      [
        { type: "api_retry", attempt: 1, errorStatus: 529, error: "overloaded" },
        { type: "model_switch", to: `model-${TOKEN}`, source: "auto" },
        { type: "end", summary: summary("ok") },
      ],
      {},
    );
    const events = gateway.events.filter(
      (e) => e.kind === "model_switch" || e.kind === "model_retry",
    );
    expect(events).toHaveLength(2);
    const text = JSON.stringify(events);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("Write the note");
  });
});
