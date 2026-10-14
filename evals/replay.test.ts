// T1: trajectory replay against the real sidecar loop and the fake SDK (test strategy §4.3,
// measurement §5.1). No network, no Docker, no model.
//
// The fixture is not hand-written JSON. One scripted run is driven through `runOnce` to produce
// real ledger events, those events are handed to `buildTrace` in the shape the operator API
// returns them, and the trace is replayed. That is the whole point of the harness: if the
// exporter and the replayer disagree about what an event means, this test fails rather than
// quietly passing on a fixture that matches neither.

import { createHash } from "node:crypto";
import {
  type BotId,
  type PinnedCandidate,
  type RunId,
  type StartRunRequest,
  type ThreadId,
  type WorkspaceId,
  assemblePinnedIndex,
  skillHashInput,
  skillMarkdown,
} from "@deskmates/contracts";
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
import { exportTraces } from "./replay/export.js";
import { replayTrace, requestFromTrace } from "./replay/replay-run.js";
import { renderReport } from "./replay/report.js";
import {
  type ApiRun,
  type ApiRunEvent,
  type RunTrace,
  type TraceMemoryVersion,
  TraceSecretError,
  type TraceSkillVersion,
  assertNoSecrets,
  buildTrace,
  findSecretShaped,
  rebuildMemoryIndex,
  rebuildSkillSet,
} from "./replay/trace.js";

const HOME = "/home/nova";
const TOKEN = "deskmates-run-token-9f3c2a1b7e";

function startRequest(): StartRunRequest {
  return {
    runId: "run-replay-1" as RunId,
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

const summaryBlock = (reply: string) =>
  `${reply}\n\`\`\`json\n${JSON.stringify({
    done: "checked the queue",
    filesChanged: ["/work/notes.md"],
    sitesVisited: ["ops.example.test"],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  })}\n\`\`\``;

/**
 * Run the script once for real and turn what the Gateway received into the shapes its operator
 * API would hand the exporter back.
 */
async function recordRun(
  script: ScriptStep[],
  gatewayOpts: FakeGatewayOptions = {},
): Promise<RunTrace> {
  const sdk = createFakeSdk(script);
  const gateway = createFakeGateway(gatewayOpts);
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
  const ended = await runOnce(request, deps, {
    approvalPollMs: 1,
    batchDelayMs: 1,
    writeStdout: () => {},
  });

  const events: ApiRunEvent[] = gateway.events.map((e) => ({
    runId: e.runId,
    seq: e.seq,
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
    attempt: 1,
    createdAt: "2026-09-21T10:00:00.000Z",
    config: { shortWaitSeconds: 300, maxTurns: 50 },
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

/** A read, a blocked navigation and a write: three tiers and an egress verdict in one run. */
const mixedScript: ScriptStep[] = [
  { type: "thinking", text: "Look at the queue first." },
  {
    type: "tool_call",
    name: "mcp__browser__browser_navigate",
    input: { url: "https://ops.example.test/tickets" },
    result: "Navigated",
  },
  {
    type: "tool_call",
    name: "mcp__browser__browser_navigate",
    input: { url: "https://evil.example.com/steal" },
    result: "Navigated",
  },
  {
    type: "tool_call",
    name: "Write",
    input: { file_path: "/work/notes.md", content: "3 open tickets" },
    result: "Wrote /work/notes.md",
  },
  { type: "text", text: summaryBlock("Three tickets are open.") },
  { type: "end", summary: summaryBlock("Three tickets are open."), usage: { inputTokens: 120 } },
];

describe("replay of a recorded trajectory", () => {
  it("replays a trace of the run it was exported from with no decision diff", async () => {
    const trace = await recordRun(mixedScript);
    expect(trace.events.length).toBeGreaterThan(0);

    const result = await replayTrace(trace);
    expect(result.error).toBeUndefined();
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(true);
    expect(result.outcome).toBe("completed");
  });

  it("records the tiers and the egress verdict the run actually took", async () => {
    const trace = await recordRun(mixedScript);
    const points = decisionPoints(trace.events);
    expect(points.map((p) => p.tool)).toEqual([
      "mcp__browser__browser_navigate",
      "mcp__browser__browser_navigate",
      "Write",
    ]);
    expect(points.map((p) => p.riskLevel)).toEqual(["L0", "L0", "L1"]);
    expect(points.map((p) => p.egress)).toEqual(["allowed", "blocked", "allowed"]);
    expect(points.map((p) => p.hookDecision)).toEqual(["allow", "deny", "allow"]);
    expect(points.map((p) => p.browserLock)).toEqual(["granted", "granted", "granted"]);
  });

  it("ignores the Gateway's connector attribution events when reading decisions", async () => {
    const recorded = await recordRun(mixedScript);
    const last = recorded.events.reduce((max, e) => Math.max(max, e.seq), 0);
    // The connector proxy's bookkeeping pair (ADR-0012 item 7): Gateway-originated, no attempt,
    // no toolUseId, `source: "connector_proxy"`.
    const proxyPair = [
      {
        seq: last + 1,
        kind: "tool_call" as const,
        payload: {
          source: "connector_proxy",
          toolName: "mcp__deskmates__connector_submit",
          operation: "submit",
          connectorId: "con_1",
          botId: recorded.run.botId,
        },
        ts: "2026-09-29T00:00:00.000Z",
      },
      {
        seq: last + 2,
        kind: "tool_result" as const,
        payload: { source: "connector_proxy", operation: "submit", receiptId: "rcp_1" },
        ts: "2026-09-29T00:00:00.000Z",
      },
    ];
    const trace = { ...recorded, events: [...recorded.events, ...proxyPair] };

    expect(decisionPoints(trace.events).map((p) => p.tool)).toEqual(
      decisionPoints(recorded.events).map((p) => p.tool),
    );
    const result = await replayTrace(trace);
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(true);
  });

  it("ignores the Gateway's integration attribution events when reading decisions", async () => {
    const recorded = await recordRun(mixedScript);
    const last = recorded.events.reduce((max, e) => Math.max(max, e.seq), 0);
    // The integrations module's bookkeeping pair (ADR-0013 item 7).
    const proxyPair = [
      {
        seq: last + 1,
        kind: "tool_call" as const,
        payload: {
          source: "integration_proxy",
          toolName: "mcp__deskmates__integration_execute",
          operation: "execute",
          service: "gitea",
          actionId: "gitea.list_my_repositories",
          connectionName: "main",
          operationType: "read",
          botId: recorded.run.botId,
        },
        ts: "2026-09-29T00:00:00.000Z",
      },
      {
        seq: last + 2,
        kind: "tool_result" as const,
        payload: { source: "integration_proxy", operation: "execute", executionId: "exec-1" },
        ts: "2026-09-29T00:00:00.000Z",
      },
    ];
    const trace = { ...recorded, events: [...recorded.events, ...proxyPair] };

    expect(decisionPoints(trace.events).map((p) => p.tool)).toEqual(
      decisionPoints(recorded.events).map((p) => p.tool),
    );
    const result = await replayTrace(trace);
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(true);
  });

  it("reports one mismatch naming the field when a recorded risk level is changed", async () => {
    const trace = await recordRun(mixedScript);
    const toolCall = trace.events.find(
      (e) => e.kind === "tool_call" && e.payload.toolName === "Write",
    );
    expect(toolCall).toBeDefined();
    // As if the tier table had called this write L2 when the trace was recorded.
    if (toolCall) toolCall.payload.riskLevel = "L2";

    const result = await replayTrace(trace);
    expect(result.identical).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      tool: "Write",
      field: "riskLevel",
      recorded: "L2",
      replayed: "L1",
    });
    expect(result.mismatches[0]?.seq).toBe(toolCall?.seq);
  });

  it("replays a recorded deny to the same deny", async () => {
    const script: ScriptStep[] = [
      {
        type: "tool_call",
        name: "Bash",
        input: { command: "git push origin main" },
        result: "pushed",
      },
      { type: "text", text: summaryBlock("Asked and was refused.") },
      { type: "end", summary: summaryBlock("Asked and was refused.") },
    ];
    const trace = await recordRun(script, {
      approvalResponder: (req) => ({
        type: "approval_response",
        approvalId: req.approvalId,
        decision: "deny",
        reason: "not this branch",
      }),
    });

    const recorded = decisionPoints(trace.events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ tool: "Bash", riskLevel: "L2", hookDecision: "deny" });

    const result = await replayTrace(trace);
    expect(result.mismatches).toEqual([]);
    expect(result.identical).toBe(true);
    expect(result.replayed[0]).toMatchObject({ riskLevel: "L2", hookDecision: "deny" });
  });

  it("replays a recorded human takeover to the same browser-lock denial", async () => {
    const script: ScriptStep[] = [
      {
        type: "tool_call",
        name: "mcp__browser__browser_snapshot",
        input: {},
        result: "snapshot",
      },
      { type: "text", text: summaryBlock("A human has the browser.") },
      { type: "end", summary: summaryBlock("A human has the browser.") },
    ];
    const trace = await recordRun(script, {
      lockResponder: (req) => ({
        type: "browser_lock_result",
        runId: req.runId,
        granted: false,
        waitMessage: "A human is operating the browser.",
      }),
    });
    expect(decisionPoints(trace.events)[0]).toMatchObject({
      browserLock: "blocked_by_human",
      hookDecision: "deny",
    });

    const result = await replayTrace(trace);
    expect(result.mismatches).toEqual([]);
    expect(result.replayed[0]).toMatchObject({ browserLock: "blocked_by_human" });
  });
});

describe("the export guard", () => {
  it("rejects a trace carrying a bearer token", async () => {
    const trace = await recordRun(mixedScript);
    expect(() => assertNoSecrets(trace)).not.toThrow();

    const call = trace.events.find((e) => e.kind === "tool_call");
    if (call) {
      call.payload.input = {
        command: "curl -H 'Authorization: Bearer sk-live-4f2b9c8e11aa' https://ops.example.test",
      };
    }
    expect(() => assertNoSecrets(trace)).toThrow(TraceSecretError);
    try {
      assertNoSecrets(trace);
    } catch (err) {
      expect((err as TraceSecretError).findings.map((f) => f.kind)).toContain("bearer token");
    }
  });

  it("does not take a redacted value for a secret", () => {
    const text = JSON.stringify({
      input: { headers: { cookie: "[redacted]", authorization: "Bearer [redacted]" } },
      url: "https://ops.example.test/x?token=[redacted]",
    });
    expect(findSecretShaped(text)).toEqual([]);
  });
});

describe("export over the operator API", () => {
  /** Only the five read routes the exporter is allowed to use; anything else is a 404 here. */
  function stubGateway(): { fetch: typeof globalThis.fetch; urls: string[] } {
    const urls: string[] = [];
    const bodies: Record<string, unknown> = {
      "/api/runs": {
        runs: [
          {
            id: "run-a",
            botId: "bot-nova",
            status: "succeeded",
            attempt: 1,
            triggerKind: "cron",
            createdAt: "2026-09-21T09:00:00.000Z",
          },
          {
            id: "run-b",
            botId: "bot-nova",
            status: "running",
            attempt: 1,
            triggerKind: "cron",
            createdAt: "2026-09-22T09:00:00.000Z",
          },
          {
            id: "run-c",
            botId: "bot-nova",
            status: "succeeded",
            attempt: 1,
            triggerKind: "cron",
            createdAt: "2026-09-19T09:00:00.000Z",
          },
        ],
      },
      "/api/runs/run-a": {
        run: {
          id: "run-a",
          botId: "bot-nova",
          lane: "background",
          triggerKind: "cron",
          triggerRef: "0",
          status: "succeeded",
          attempt: 1,
          createdAt: "2026-09-21T09:00:00.000Z",
          config: { shortWaitSeconds: 120, maxTurns: 30 },
          triggerPayload: { prompt: "check the queue", schedule: "*/5 * * * *", entry: 0 },
        },
        usage: [
          {
            model: "m",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
      },
      "/api/runs/run-a/events": {
        events: [
          {
            runId: "run-a",
            seq: 1,
            attempt: 1,
            kind: "tool_call",
            payload: {
              toolUseId: "toolu_1",
              toolName: "Read",
              input: { file_path: "/work/a" },
              riskLevel: "L0",
            },
            ts: "2026-09-21T09:00:01.000Z",
          },
        ],
      },
      "/api/bots/bot-nova": {
        bot: {
          id: "bot-nova",
          name: "nova",
          workspaceId: "ws-1",
          model: "m",
          cheapModel: "c",
          connectors: [],
        },
      },
      "/api/workspaces/ws-1": { workspace: { id: "ws-1", egressAllowlist: ["ops.example.test"] } },
    };
    return {
      urls,
      fetch: (async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        const body = bodies[new URL(url).pathname];
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch,
    };
  }

  it("takes only terminal runs since the cutoff and builds a replayable trace from five GETs", async () => {
    const stub = stubGateway();
    const traces = await exportTraces({
      gateway: "http://gateway.test/",
      since: "2026-09-20T00:00:00.000Z",
      fetch: stub.fetch,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });

    // run-b is still running, run-c predates the cutoff.
    expect(traces.map((t) => t.run.id)).toEqual(["run-a"]);
    expect(stub.urls.every((u) => u.startsWith("http://gateway.test/api/"))).toBe(true);
    const trace = traces[0];
    expect(trace?.trigger).toEqual({ kind: "cron", prompt: "check the queue" });
    expect(trace?.triggerSource).toBe("run_payload");
    expect(trace?.shortWaitSeconds).toBe(120);
    expect(trace?.maxTurns).toBe(30);
    expect(trace?.egressAllowlist).toEqual(["ops.example.test"]);
    expect(trace?.run.botHomeDir).toBe("/home/nova");
    // No thread, so no thread tools were offered and none are put back on the replay.
    expect(trace?.tools).toEqual([]);
    expect(trace?.events).toHaveLength(1);

    const result = await replayTrace(trace as RunTrace);
    expect(result.mismatches).toEqual([]);
  });

  it("exports the runs named with --run even when they are outside the window", async () => {
    const stub = stubGateway();
    const traces = await exportTraces({
      gateway: "http://gateway.test",
      runIds: ["run-a"],
      fetch: stub.fetch,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });
    expect(traces.map((t) => t.run.id)).toEqual(["run-a"]);
    expect(stub.urls).not.toContain("http://gateway.test/api/runs");
  });
});

describe("the markdown report", () => {
  it("renders a summary line and a table per trace with mismatches", async () => {
    const clean = await recordRun(mixedScript);
    const dirty = await recordRun(mixedScript);
    const call = dirty.events.find((e) => e.kind === "tool_call");
    if (call) call.payload.riskLevel = "L2";

    const results = [await replayTrace(clean, "evals/traces/a.json"), await replayTrace(dirty)];
    const markdown = renderReport(results, { generatedAt: "2026-09-22T00:00:00.000Z" });

    expect(markdown).toContain("# Trajectory replay");
    expect(markdown).toContain("2 trace(s) replayed at 2026-09-22T00:00:00.000Z");
    expect(markdown).toContain("1 identical, 1 with mismatches");
    expect(markdown).toContain("| seq | tool | field | recorded | replayed |");
    expect(markdown).toContain("| riskLevel |");
    expect(markdown).toContain("identical");
    expect(markdown).toContain("evals/traces/a.json");
  });
});

// ADR-0011 Verification row 12: `runs.config_json` names every memory entry version the run
// received; the exporter fetches exactly those versions and replay rebuilds the same index.
describe("replay restores the pinned memory index", () => {
  const candidates: PinnedCandidate[] = [
    {
      id: "mem_w",
      version: 2,
      scope: "workspace",
      kind: "note",
      body: "S3 egress is billed separately.",
      authority: "fact",
      trust: "trusted",
      observedAt: "2026-09-28T00:00:00.000Z",
      tombstoned: false,
      learnedBy: "nova",
    },
    {
      id: "mem_b",
      version: 1,
      scope: "bot",
      kind: "note",
      body: "Export before closing.\nThen file the ticket.",
      authority: "procedure",
      trust: "trusted",
      observedAt: "2026-09-27T00:00:00.000Z",
      tombstoned: false,
    },
  ];
  const index = assemblePinnedIndex(candidates, new Date("2026-09-29T00:00:00.000Z"));
  const memoryConfig = {
    indexVersion: 1,
    assembledAt: index.assembledAt,
    budgets: index.budgets,
    versionSet: index.versionSet,
    lines: index.lines,
    counts: index.counts,
  };
  const versions: TraceMemoryVersion[] = candidates.map((c) => ({
    entryId: c.id,
    version: c.version,
    scope: c.scope,
    body: c.body,
    authority: c.authority,
    observedAt: c.observedAt,
    ...(c.learnedBy ? { learnedBy: c.learnedBy } : {}),
  }));

  it("rebuilds the exact index from the recorded version set", () => {
    const trace = buildTrace({
      gateway: "http://gateway.test",
      exportedAt: "2026-09-29T01:00:00.000Z",
      run: {
        id: "run-mem",
        botId: "bot-nova",
        triggerKind: "cron",
        status: "succeeded",
        attempt: 1,
        config: { memory: memoryConfig },
        triggerPayload: { prompt: "go" },
      },
      events: [],
      bot: { id: "bot-nova", name: "nova", workspaceId: "ws-1" },
      workspace: { id: "ws-1" },
      memoryVersions: versions,
    });
    expect(requestFromTrace(trace).memoryIndex).toEqual(index);
    const { counts: _, ...beforeCounts } = memoryConfig;
    expect(rebuildMemoryIndex({ memory: beforeCounts }, versions)).not.toHaveProperty("counts");
    expect(rebuildMemoryIndex({ memory: memoryConfig }, versions.slice(1))).toBeUndefined();
    const redacted = versions.map((v, i) => (i === 0 ? { ...v, redacted: true } : v));
    expect(rebuildMemoryIndex({ memory: memoryConfig }, redacted)).toBeUndefined();
  });

  it("fetches exactly the recorded versions when exporting", async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown> = {
      "/api/runs/run-mem": {
        run: {
          id: "run-mem",
          botId: "bot-nova",
          triggerKind: "cron",
          status: "succeeded",
          attempt: 1,
          config: { memory: memoryConfig },
          triggerPayload: { prompt: "go" },
        },
      },
      "/api/runs/run-mem/events": { events: [] },
      "/api/bots/bot-nova": { bot: { id: "bot-nova", name: "nova", workspaceId: "ws-1" } },
      "/api/workspaces/ws-1": { workspace: { id: "ws-1" } },
      "/api/memory/versions": { versions },
    };
    const fetchFn = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const body = bodies[new URL(url).pathname];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(body));
    }) as typeof globalThis.fetch;
    const [trace] = await exportTraces({
      gateway: "http://gateway.test",
      runIds: ["run-mem"],
      fetch: fetchFn,
    });
    const versionUrl = urls.find((u) => u.includes("/api/memory/versions"));
    expect(new URL(versionUrl ?? "http://x").searchParams.get("refs")).toBe("mem_w@2,mem_b@1");
    expect(trace?.memoryVersions).toEqual(versions);
    if (!trace) throw new Error("no trace");
    expect(requestFromTrace(trace).memoryIndex).toEqual(index);
  });
});

// ADR-0015 Verification row 7: `runs.config_json` names every skill and hash the run was given;
// the exporter fetches exactly those versions and replay rebuilds the same skill set.
describe("replay restores the run's skill set", () => {
  const files = [
    {
      path: "SKILL.md",
      content: skillMarkdown({
        name: "export-refunds",
        description: "Export the refund sheet.",
        body: "1. Export. 2. Attach.",
      }),
    },
    { path: "reference.md", content: "Columns: id, amount." },
  ];
  const sha256 = createHash("sha256").update(skillHashInput(files)).digest("hex");
  const ref = { skillId: "skill_1", name: "export-refunds", version: 3, sha256 };
  const config = { skills: { version: 1, set: [ref] } };
  const versions: TraceSkillVersion[] = [{ ...ref, files }];
  const run = {
    id: "run-skill",
    botId: "bot-nova",
    triggerKind: "cron" as const,
    status: "succeeded" as const,
    attempt: 1,
    config,
    triggerPayload: { prompt: "go" },
  };

  it("rebuilds the exact set from the recorded refs, and nothing else", () => {
    expect(rebuildSkillSet(config, versions)).toEqual([{ ...ref, files }]);
    expect(rebuildSkillSet({}, versions)).toBeUndefined();
    expect(rebuildSkillSet(config, [])).toBeUndefined();
    const changed = [{ ...ref, files: [...files, { path: "extra.md", content: "x" }] }];
    expect(rebuildSkillSet(config, changed)).toBeUndefined();
  });

  it("fetches exactly the recorded versions when exporting and puts them on the request", async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown> = {
      "/api/runs/run-skill": { run },
      "/api/runs/run-skill/events": { events: [] },
      "/api/bots/bot-nova": { bot: { id: "bot-nova", name: "nova", workspaceId: "ws-1" } },
      "/api/workspaces/ws-1": { workspace: { id: "ws-1" } },
      "/api/skills/versions": {
        versions: versions.map((v) => ({ ...v, op: "author", review: "cleared" })),
      },
    };
    const fetchFn = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const body = bodies[new URL(url).pathname];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(body));
    }) as typeof globalThis.fetch;
    const [trace] = await exportTraces({
      gateway: "http://gateway.test",
      runIds: ["run-skill"],
      fetch: fetchFn,
    });
    const skillUrl = urls.find((u) => u.includes("/api/skills/versions"));
    expect(new URL(skillUrl ?? "http://x").searchParams.get("refs")).toBe("skill_1@3");
    expect(trace?.skillVersions).toEqual(versions);
    if (!trace) throw new Error("no trace");
    expect(requestFromTrace(trace).skills).toEqual([{ ...ref, files }]);
  });
});

describe("a trace carries the run's visibility (issue #70)", () => {
  const base = {
    gateway: "http://gateway.test",
    exportedAt: "2026-10-12T00:00:00.000Z",
    bot: { id: "bot-nova", name: "nova", workspaceId: "ws-1" },
    workspace: { id: "ws-1" },
  };
  const silentRun: ApiRun = {
    id: "run-v",
    botId: "bot-nova",
    threadId: "thr-1",
    triggerKind: "thread_message",
    status: "silent",
    attempt: 1,
    summary: {
      done: "posted",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "",
    },
  };
  const posted: ApiRunEvent = {
    seq: 1,
    kind: "log",
    payload: { tool: "thread_post", threadId: "thr-1", messageId: "msg-1" },
    ts: "2026-10-12T00:00:00.000Z",
  };

  it("keeps the status and takes the flags the Gateway reported", () => {
    const visibility = {
      finalReply: false,
      postedToThread: false,
      decidedApproval: true,
      deliveredTask: false,
      visibleOutcome: true,
    };
    const trace = buildTrace({ ...base, run: { ...silentRun, visibility }, events: [] });
    expect(trace.run.status).toBe("silent");
    expect(trace.run.visibility).toEqual(visibility);
  });

  it("derives the flags from the ledger when an older Gateway did not report them", () => {
    const trace = buildTrace({ ...base, run: silentRun, events: [posted] });
    expect(trace.run.status).toBe("silent");
    expect(trace.run.visibility).toEqual({
      finalReply: false,
      postedToThread: true,
      decidedApproval: false,
      deliveredTask: false,
      visibleOutcome: true,
    });
  });
});
