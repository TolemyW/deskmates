// T1: the defects an independent QA pass found in the replay tool, adopted as tests
// (`docs/design/m1-independent-qa-2026-09-22.md`, findings QA-01 to QA-05). Same rules as
// `replay.test.ts`: the fixtures are recorded by driving `runOnce` for real against the fake SDK
// and the sidecar's fake Gateway, never hand-written JSON, so a fixture cannot drift away from
// what the sidecar actually does. No network, no Docker, no model.
//
// Every credential in this file is synthetic.

import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import type { SidecarDeps } from "@deskmates/sidecar/deps.js";
import { runOnce } from "@deskmates/sidecar/run-once.js";
import {
  type FakeGatewayOptions,
  createFakeGateway,
} from "@deskmates/sidecar/testing/fake-gateway.js";
import { createMemoryFs } from "@deskmates/sidecar/testing/in-memory-fs.js";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import { decisionPoints } from "./replay/decisions.js";
import { replayTrace } from "./replay/replay-run.js";
import { renderReport } from "./replay/report.js";
import {
  type ApiRun,
  type ApiRunEvent,
  type RunTrace,
  TraceSecretError,
  type TraceSource,
  assertNoSecrets,
  buildTrace,
} from "./replay/trace.js";

const HOME = "/home/nova";
const TOKEN = "deskmates-run-token-9f3c2a1b7e";

/** A synthetic credential: not a bearer token, not an `sk-` key, so only a key walk finds it. */
const MARKER = "QA_SYNTHETIC_CREDENTIAL_123456789";

function startRequest(): StartRunRequest {
  return {
    runId: "run-replay-qa" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    botRole: "research assistant",
    workspaceName: "Ops",
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
          body: "Check the ticket queue and file the report",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: TOKEN,
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: ["ops.example.test"],
    connectors: [],
    tools: ["thread_post"],
  };
}

interface RecordOptions {
  gateway?: FakeGatewayOptions;
  /** Run a second sidecar process for the same run, the way the Gateway's resume does. */
  resume?: boolean;
}

/**
 * Run the script for real and turn what the Gateway received into the shapes its operator API
 * would hand the exporter back. With `resume`, the deferred process is followed by a second one
 * on the same SDK session, exactly as `RunLifecycle.resume` starts it, and the broker's `decided`
 * event is inserted between them: without it the trace does not say what the human answered and
 * is not representative of a real resume.
 */
async function recordRun(script: ScriptStep[], opts: RecordOptions = {}): Promise<RunTrace> {
  const sdk = createFakeSdk(script);
  const gateway = createFakeGateway(opts.gateway ?? {});
  const fs = createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova, the ops bot." });
  let clock = Date.parse("2026-09-21T10:00:00Z");
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: gateway.fetch,
    fs,
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  const request = startRequest();
  if (opts.resume) request.shortWaitSeconds = 1;
  let ended = await runOnce(request, deps, {
    approvalPollMs: 1,
    batchDelayMs: 1,
    writeStdout: () => {},
  });

  if (opts.resume) {
    if (ended.outcome !== "deferred" || !ended.sdkSessionId || !ended.pendingApprovalId) {
      throw new Error(`fixture did not defer: ${ended.outcome}`);
    }
    // The broker records the human's decision before the scheduler starts the next attempt.
    gateway.events.push({
      type: "event",
      runId: request.runId,
      seq: gateway.events.length + 1,
      attempt: 1,
      kind: "approval",
      ts: deps.now().toISOString(),
      payload: {
        phase: "decided",
        approvalId: ended.pendingApprovalId,
        decision: "allow_once",
        decidedBy: "human:qa",
      },
    });
    const action = gateway.approvals[0]?.action;
    const next: StartRunRequest = {
      ...request,
      attempt: 2,
      sdkSessionId: ended.sdkSessionId,
      trigger: {
        kind: "approval",
        approvalId: ended.pendingApprovalId,
        decision: "allow_once",
        ...(ended.pendingToolUseId ? { toolUseId: ended.pendingToolUseId } : {}),
        ...(ended.currentOrigin ? { currentOrigin: ended.currentOrigin } : {}),
        ...(action
          ? {
              deferredAction: {
                toolName: action.toolName,
                ...(action.targetOrigin === undefined ? {} : { targetOrigin: action.targetOrigin }),
                ...(action.argumentPattern === undefined
                  ? {}
                  : { argumentPattern: action.argumentPattern }),
              },
            }
          : {}),
      },
    };
    ended = await runOnce(next, deps, {
      approvalPollMs: 1,
      batchDelayMs: 1,
      writeStdout: () => {},
    });
  }

  // The Gateway assigns the ledger seq in arrival order across both sidecar processes.
  const events: ApiRunEvent[] = gateway.events.map((e, index) => ({
    runId: e.runId,
    seq: index + 1,
    attempt: e.attempt,
    kind: e.kind,
    payload: e.payload,
    ts: e.ts,
  }));
  const run: ApiRun = {
    id: request.runId,
    botId: request.botId,
    ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "msg-1",
    status: ended.outcome === "completed" ? "succeeded" : "failed",
    attempt: opts.resume ? 2 : 1,
    createdAt: "2026-09-21T10:00:00.000Z",
    config: { shortWaitSeconds: request.shortWaitSeconds, maxTurns: 50, model: request.model },
    ...(ended.summary === undefined ? {} : { summary: ended.summary }),
  };
  return buildTrace({
    gateway: "http://gateway.test",
    exportedAt: "2026-09-21T11:00:00.000Z",
    run,
    events,
    usage: ended.usage.map((u) => ({ ...u })),
    bot: {
      id: request.botId,
      name: request.botName,
      workspaceId: request.workspaceId,
      model: request.model,
      cheapModel: request.cheapModel,
      connectors: [],
    },
    workspace: { id: request.workspaceId, egressAllowlist: request.egressAllowlist },
  });
}

const summaryBlock = (reply: string) =>
  `${reply}\n\`\`\`json\n${JSON.stringify({
    done: reply,
    filesChanged: [],
    sitesVisited: ["ops.example.test"],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  })}\n\`\`\``;

// ---------------------------------------------------------------------------
// QA-01: a call stopped before the lock must not consume a lock answer
// ---------------------------------------------------------------------------

describe("QA-01: lock answers follow the calls that asked for the lock", () => {
  it("control: a human takeover alone replays identically", async () => {
    const trace = await recordRun(
      [
        { type: "tool_call", name: "mcp__browser__browser_snapshot", input: {}, result: "snap" },
        { type: "end", summary: summaryBlock("A human has the browser.") },
      ],
      {
        gateway: {
          lockResponder: (req) => ({
            type: "browser_lock_result",
            runId: req.runId,
            granted: false,
            waitMessage: "A human is operating the browser.",
          }),
        },
      },
    );
    expect((await replayTrace(trace)).mismatches).toEqual([]);
  });

  it("replays a navigation denied by egress followed by a held and a free browser", async () => {
    let acquires = 0;
    const trace = await recordRun(
      [
        {
          type: "tool_call",
          name: "mcp__browser__browser_navigate",
          input: { url: "https://outside.example.test/" },
          result: "Navigated",
        },
        { type: "tool_call", name: "mcp__browser__browser_snapshot", input: {}, result: "snap" },
        { type: "tool_call", name: "mcp__browser__browser_snapshot", input: {}, result: "snap" },
        { type: "end", summary: summaryBlock("Looked twice.") },
      ],
      {
        gateway: {
          lockResponder: (req) => {
            if (req.op !== "acquire") {
              return { type: "browser_lock_result", runId: req.runId, granted: true };
            }
            acquires += 1;
            // The denied navigation never reaches the lock, so the first acquire is the snapshot.
            return acquires === 1
              ? {
                  type: "browser_lock_result",
                  runId: req.runId,
                  granted: false,
                  waitMessage: "A human is operating the browser.",
                }
              : { type: "browser_lock_result", runId: req.runId, granted: true };
          },
        },
      },
    );

    const points = decisionPoints(trace.events);
    expect(points.map((p) => p.egress)).toEqual(["blocked", "allowed", "allowed"]);
    expect(points.map((p) => p.browserLock)).toEqual(["granted", "blocked_by_human", "granted"]);
    expect(points.map((p) => p.hookDecision)).toEqual(["deny", "deny", "allow"]);

    const result = await replayTrace(trace);
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QA-02: a resumed run is two sidecar processes, and replays as two
// ---------------------------------------------------------------------------

describe("QA-02: attempt-aware replay of a resumed run", () => {
  it("control: a deferred then approved command replays both attempts", async () => {
    const trace = await recordRun(
      [
        {
          type: "tool_call",
          name: "Bash",
          input: { command: "git push origin main" },
          result: "pushed",
        },
        { type: "end", summary: summaryBlock("Pushed.") },
      ],
      { gateway: { approvalResponder: () => "pending" }, resume: true },
    );
    expect(trace.run.attempt).toBe(2);
    expect([...new Set(trace.events.map((e) => e.attempt))]).toEqual([1, 2]);

    const result = await replayTrace(trace);
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(true);
    expect(result.outcome).toBe("completed");
  });

  it("keeps the approved retry after the replayed click fails on a stale ref", async () => {
    const trace = await recordRun(
      [
        {
          type: "tool_call",
          name: "mcp__browser__browser_navigate",
          input: { url: "https://ops.example.test/checkout" },
          result: "Navigated",
        },
        {
          type: "tool_call",
          name: "mcp__browser__browser_click",
          input: { element: "Submit order button", ref: "old-ref" },
          result: "Error: Ref old-ref not found in the current page snapshot",
          isError: true,
        },
        {
          type: "tool_call",
          name: "mcp__browser__browser_snapshot",
          input: {},
          result: '- button "Submit order button" [ref=new-ref]',
        },
        {
          type: "tool_call",
          name: "mcp__browser__browser_click",
          input: { element: "Submit order button", ref: "new-ref" },
          result: "Clicked",
        },
        { type: "end", summary: summaryBlock("Order submitted.") },
      ],
      { gateway: { approvalResponder: () => "pending" }, resume: true },
    );

    expect(
      trace.events.filter((e) => e.kind === "approval").map((e) => e.payload.consumedBy),
    ).toContain("retry");
    expect(decisionPoints(trace.events).map((p) => p.hookDecision)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
    ]);

    const result = await replayTrace(trace);
    expect(result.unsupported).toBeUndefined();
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(true);
  });

  it("reports a trace whose resume decision was never recorded as unsupported", async () => {
    const trace = await recordRun(
      [
        {
          type: "tool_call",
          name: "Bash",
          input: { command: "git push origin main" },
          result: "pushed",
        },
        { type: "end", summary: summaryBlock("Pushed.") },
      ],
      { gateway: { approvalResponder: () => "pending" }, resume: true },
    );
    // A trace that has the second attempt but not the events that say what the human answered:
    // neither the Gateway's `decided` nor the resumed sidecar's `resumed`. Nothing can rebuild
    // the trigger the second process was started with.
    trace.events = trace.events.filter((e) => {
      if (e.kind !== "approval") return true;
      const phase = e.payload.phase;
      return phase !== "resumed" && phase !== "decided";
    });

    const result = await replayTrace(trace, "evals/traces/qa.json");
    expect(result.unsupported).toBeDefined();
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(false);

    const markdown = renderReport([result], { generatedAt: "2026-09-22T00:00:00.000Z" });
    expect(markdown).toContain("unsupported");
    expect(markdown).toContain(result.unsupported as string);
  });
});

// ---------------------------------------------------------------------------
// QA-03: the model a trace names is the model the run used
// ---------------------------------------------------------------------------

describe("QA-03: recorded run metadata decides the model", () => {
  const source = (): TraceSource => ({
    gateway: "http://qa.invalid",
    exportedAt: "2026-09-22T00:00:00.000Z",
    run: {
      id: "qa-run",
      botId: "qa-bot",
      triggerKind: "cron",
      status: "succeeded",
      attempt: 1,
      config: { defaultModel: "historical-model", cheapModel: "historical-cheap" },
      triggerPayload: { prompt: "Read the queue" },
    },
    events: [],
    bot: { id: "qa-bot", name: "qa", workspaceId: "qa-workspace" },
    workspace: { id: "qa-workspace", egressAllowlist: ["ops.example.test"] },
  });

  it("uses the run's recorded defaultModel when the bot inherits it", () => {
    const trace = buildTrace(source());
    expect(trace.run.model).toBe("historical-model");
    expect(trace.run.modelSource).toBe("run_config");
  });

  it("does not replace a recorded effective model with the bot's current model", () => {
    const input = source();
    input.run.config = { model: "historical-override", cheapModel: "historical-cheap" };
    input.bot.model = "new-model";
    const trace = buildTrace(input);
    expect(trace.run.model).toBe("historical-override");
    expect(trace.run.modelSource).toBe("run_config");
  });

  it("falls back to the bot and says so when the run row recorded no model", () => {
    const input = source();
    input.run.config = { shortWaitSeconds: 120 };
    input.bot.model = "current-model";
    const trace = buildTrace(input);
    expect(trace.run.model).toBe("current-model");
    expect(trace.run.modelSource).toBe("bot");
  });
});

// ---------------------------------------------------------------------------
// QA-04 and QA-05: the export guard
// ---------------------------------------------------------------------------

describe("QA-04: the export guard sees structured credentials", () => {
  function traceWithPayload(payload: Record<string, unknown>): RunTrace {
    const trace = buildTrace({
      gateway: "http://qa.invalid",
      exportedAt: "2026-09-22T00:00:00.000Z",
      run: {
        id: "qa-run",
        botId: "qa-bot",
        triggerKind: "cron",
        status: "succeeded",
        attempt: 1,
        config: {},
        triggerPayload: { prompt: "Read the queue" },
      },
      events: [],
      bot: { id: "qa-bot", name: "qa", workspaceId: "qa-workspace" },
      workspace: { id: "qa-workspace", egressAllowlist: ["ops.example.test"] },
    });
    trace.events.push({ seq: 1, kind: "log", ts: trace.exportedAt, payload });
    return trace;
  }

  it("control: already-redacted headers are accepted", () => {
    const trace = traceWithPayload({
      headers: { cookie: "[redacted]", "x-api-key": "[redacted]" },
    });
    expect(() => assertNoSecrets(trace)).not.toThrow();
  });

  it.each(["cookie", "x-api-key", "authorization"])(
    "catches an unredacted %s header by key, quotes and all",
    (header) => {
      const trace = traceWithPayload({ headers: { [header]: `SESSION=${MARKER}` } });
      expect(() => assertNoSecrets(trace)).toThrow(TraceSecretError);
      try {
        assertNoSecrets(trace);
      } catch (error) {
        const findings = (error as TraceSecretError).findings;
        expect(findings.map((f) => f.path)).toContain(`events[0].payload.headers.${header}`);
      }
    },
  );

  it("still catches a credential embedded in prose", () => {
    const trace = traceWithPayload({ text: `Authorization: Bearer sk-live-${MARKER}` });
    expect(() => assertNoSecrets(trace)).toThrow(TraceSecretError);
    try {
      assertNoSecrets(trace);
    } catch (error) {
      expect((error as TraceSecretError).findings.map((f) => f.kind)).toContain("bearer token");
    }
  });

  it("does not take an ordinary identifier for a credential", () => {
    const trace = traceWithPayload({
      toolUseId: "toolu_123456789",
      inputTokens: 1200,
      threadId: "thread-1",
    });
    expect(() => assertNoSecrets(trace)).not.toThrow();
  });
});

describe("QA-05: the guard never prints what it caught", () => {
  it("names the run, the path and the kind, and no part of the value", () => {
    const trace = buildTrace({
      gateway: "http://qa.invalid",
      exportedAt: "2026-09-22T00:00:00.000Z",
      run: {
        id: "qa-run",
        botId: "qa-bot",
        triggerKind: "cron",
        status: "succeeded",
        attempt: 1,
        config: {},
      },
      events: [],
      bot: { id: "qa-bot", name: "qa", workspaceId: "qa-workspace" },
      workspace: { id: "qa-workspace" },
    });
    trace.events.push({
      seq: 1,
      kind: "log",
      ts: trace.exportedAt,
      payload: { text: `Authorization: Bearer ${MARKER}` },
    });

    let caught: TraceSecretError | undefined;
    try {
      assertNoSecrets(trace);
    } catch (error) {
      caught = error as TraceSecretError;
    }
    expect(caught).toBeInstanceOf(TraceSecretError);
    if (!caught) throw new Error("unreachable");

    // `evals/replay.ts` writes `String(err)` to stderr; `JSON.stringify` covers a CI runner that
    // serialises the whole error, findings included.
    const printed = `${String(caught)} ${JSON.stringify(caught.findings)}`;
    expect(printed).toContain("qa-run");
    expect(printed).toContain("events[0].payload.text");
    expect(printed).toContain("bearer token");
    expect(printed).not.toContain(MARKER);
    for (let i = 0; i + 8 <= MARKER.length; i += 1) {
      expect(printed).not.toContain(MARKER.slice(i, i + 8));
    }
  });
});
