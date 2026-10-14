// T1: the M0 slice end to end on an in-memory database with the fake provider playing the
// sidecar over real HTTP (test strategy §4.2 "one full run", coalescing, delivery semantics,
// short-lived tokens; §6 security).

import {
  DeskmatesError,
  type RunEvent,
  type RunSummary,
  type StartRunRequest,
  type Thread,
  type ThreadMessage,
} from "@deskmates/contracts";
import { FakeIntegrationRuntime } from "@deskmates/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "./ledger/runs.js";
import { sidecarToolsFor } from "./scheduler/sidecar-tools.js";
import type { FakeSidecarClient } from "./test-support/fake-provider.js";
import {
  type Harness,
  TEST_UPSTREAM_TOKEN,
  nextTurn,
  openSse,
  startHarness,
  waitFor,
} from "./test-support/harness.js";

function summary(reply: string): RunSummary {
  return {
    done: "answered",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("one full run (design v0.3 §5)", () => {
  it("attributes independent timing without consuming SDK sequence numbers", async () => {
    const { thread } = await h.seed();
    h.app.deskmates.ctx.config.strategyEvidence = { completionContract: "test-baseline" };
    h.provider.onRun(async (req, gw) => {
      const ts = new Date().toISOString();
      const sdkEvent = {
        type: "event",
        runId: req.runId,
        attempt: req.attempt,
        seq: 1,
        kind: "tool_call",
        payload: { tool: "mcp__browser__browser_snapshot" },
        ts,
      };
      const timingEvent = {
        type: "event",
        runId: req.runId,
        attempt: req.attempt,
        kind: "log",
        payload: {
          source: "phase_timing",
          version: 1,
          spanId: "proxy-observation-1",
          phase: "browser_rpc",
          edge: "start",
          at: ts,
        },
        ts,
      };
      expect((await gw.post("events", [sdkEvent, timingEvent])).status).toBe(200);
      expect((await gw.post("events", [sdkEvent])).status).toBe(200);
      expect((await gw.post("events", [{ ...timingEvent, attempt: req.attempt + 1 }])).status).toBe(
        400,
      );
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("finished"),
        usage: [],
      });
    });
    const post = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "inspect the page",
    });
    const run = post.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
    expect(
      h.app.deskmates.ctx.events
        .list(run.id)
        .map((event) => [event.seq, event.kind, event.sidecarSeq]),
    ).toEqual([
      [1, "memory_index", undefined],
      [2, "tool_call", 1],
      [3, "log", undefined],
    ]);
    h.app.deskmates.ctx.config.strategyEvidence = { completionContract: "later-candidate" };
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).config).toMatchObject({
      phaseTimingVersion: 1,
      strategyEvidence: { completionContract: "test-baseline" },
    });
  });

  it("post → queued → running → succeeded, with ledger, usage, SSE, reply and last_seen_seq", async () => {
    const { bot, thread, workspace } = await h.seed();
    h.app.deskmates.ctx.prices.upsert({
      model: "test-model-default",
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: 0.3,
      cacheCreatePerM: 3.75,
      effectiveFrom: "2020-01-01T00:00:00.000Z",
    });

    let seen: StartRunRequest | undefined;
    h.provider.onRun(async (req, gw) => {
      seen = req;
      const ts = new Date().toISOString();
      const r1 = await gw.post("events", [
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 1,
          kind: "thinking",
          payload: { text: "hmm" },
          ts,
        },
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 2,
          kind: "tool_call",
          payload: { tool: "mcp__browser__browser_navigate" },
          ts,
        },
      ]);
      expect(r1.status).toBe(200);
      const lock = await gw.post("browser-lock", {
        type: "browser_lock",
        runId: req.runId,
        op: "acquire",
        tabId: "tab-1",
      });
      expect(await lock.json()).toMatchObject({ granted: true });
      const ended = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        sdkSessionId: "sess-1",
        summary: summary("Hello back"),
        usage: [
          {
            model: "test-model-default",
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
          {
            model: "unpriced-model",
            inputTokens: 5,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
      });
      expect(ended.status).toBe(200);
    });

    const sse = await openSse(h.baseUrl, `?threadId=${thread.id}`);
    const post = await h.api<{ message: ThreadMessage; runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "hello @alice" },
    );
    expect(post.status).toBe(201);
    expect(post.json.message.seq).toBe(1);
    expect(post.json.message.mentions).toEqual([{ kind: "bot", botId: bot.id }]);
    expect(post.json.runs).toHaveLength(1);
    const run = post.json.runs[0] as RunRecord;
    expect(run.status).toBe("queued");
    expect(run.lane).toBe("interactive");
    expect(run.triggerKind).toBe("thread_message");
    expect(run.triggerRef).toBe(post.json.message.id);
    expect(run.config).toMatchObject({ defaultModel: "test-model-default" });

    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run end",
    );

    // The sidecar got the request the contracts define, with the payload and a fresh token.
    expect(seen).toBeDefined();
    const req = seen as StartRunRequest;
    expect(req.botName).toBe("alice");
    expect(req.workspaceId).toBe(workspace.id);
    expect(req.model).toBe("test-model-default");
    // A threaded run gets the thread tools, including `approval_decide` (ADR-0002 amendment 2).
    expect(req.tools).toEqual(
      sidecarToolsFor(true, h.app.deskmates.ctx.runs.mustGet(run.id).config),
    );
    expect(req.attempt).toBe(1);
    expect(req.trigger.kind).toBe("thread_message");
    if (req.trigger.kind !== "thread_message") throw new Error("unreachable");
    expect(req.trigger.messages.map((m) => m.seq)).toEqual([1]);
    expect(req.trigger.messages[0]?.authorKind).toBe("human");
    expect(req.modelAuthToken).not.toBe(TEST_UPSTREAM_TOKEN);
    // The credentials travel on stdin, in the StartRunRequest above, and nowhere else. The
    // workspace env file holds one set of values for the whole workspace, so writing a run's
    // token into it would hand a concurrent run in the same workspace the wrong token.
    expect(h.provider.injected).toEqual([]);
    expect(h.provider.execCalls[0]?.req.cmd).toEqual(["deskmates-sidecar", "run"]);

    // Ledger: the Gateway's pinned-index receipt at start, the sidecar's events, then
    // pricing_missing; usage priced by the Gateway.
    const events = await h.api<{ events: RunEvent[] }>("GET", `/api/runs/${run.id}/events`);
    expect(events.json.events.map((e) => [e.seq, e.kind])).toEqual([
      [1, "memory_index"],
      [2, "thinking"],
      [3, "tool_call"],
      [4, "log"],
      [5, "log"],
      [6, "log"],
      [7, "log"],
      [8, "pricing_missing"],
    ]);
    const detail = await h.api<{
      run: RunRecord;
      usage: { model: string; costUsd: number | null }[];
    }>("GET", `/api/runs/${run.id}`);
    expect(detail.json.run.status).toBe("succeeded");
    expect(detail.json.run.sdkSessionId).toBe("sess-1");
    expect(detail.json.run.summary?.reply).toBe("Hello back");
    expect(detail.json.usage).toEqual([
      expect.objectContaining({ model: "test-model-default", costUsd: 3 }),
      expect.objectContaining({ model: "unpriced-model", costUsd: null }),
    ]);

    // The reply is in the transcript as the bot's message linked to the run.
    const msgs = await h.api<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${thread.id}/messages`,
    );
    expect(msgs.json.messages).toHaveLength(2);
    expect(msgs.json.messages[1]).toMatchObject({
      seq: 2,
      authorKind: "bot",
      authorId: bot.id,
      body: "Hello back",
      runId: run.id,
      relayCount: 1,
    });

    // last_seen_seq advanced to what was delivered; the session id is stored per (bot, thread).
    const t = await h.api<{ members: { botId: string; lastSeenSeq: number }[] }>(
      "GET",
      `/api/threads/${thread.id}`,
    );
    expect(t.json.members[0]?.lastSeenSeq).toBe(1);
    expect(h.app.deskmates.ctx.sessions.get(bot.id, thread.id)).toBe("sess-1");

    // SSE saw the human message, every status, every ledger event and the bot's reply, in order.
    await waitFor(() => sse.events.length >= 8, 2000, "sse events");
    sse.close();
    const kinds = sse.events.map((e) =>
      e.type === "run_status"
        ? `status:${e.run.status}`
        : e.type === "run_event"
          ? `event:${e.event.kind}`
          : e.type === "approval"
            ? `approval:${e.approval.decision ?? "pending"}`
            : e.type === "workspace_lock"
              ? `lock:${e.browserLock?.holderKind ?? "free"}`
              : e.type === "workspace"
                ? `workspace:${e.workspaceId}`
                : e.type === "thread_members" || e.type === "thread_activity"
                  ? e.type
                  : e.type === "thread_pins"
                    ? `thread_pins:${e.workspaceId}`
                    : e.type === "cost_alert"
                      ? `cost_alert:${e.alert.kind}`
                      : e.type === "task_delivered"
                        ? `task_delivered:${e.task.id}`
                        : e.type === "board"
                          ? `board:${e.workspaceId}`
                          : `message:${e.message.authorKind}`,
    );
    expect(kinds).toEqual([
      "message:human",
      "status:queued",
      "status:running",
      "event:memory_index",
      "event:thinking",
      "event:tool_call",
      "event:log",
      // The committed reply precedes the transaction's ledger/status notifications.
      "message:bot",
      "event:log",
      "event:log",
      "event:log",
      "event:pricing_missing",
      "status:succeeded",
    ]);

    // The short-lived token is revoked once the run ended.
    const after = await fetch(`${h.baseUrl}/internal/runs/${run.id}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.modelAuthToken}`,
      },
      body: JSON.stringify([]),
    });
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: "token_rejected" });
  });
});

describe("wake coalescing (ADR-0005 item 8)", () => {
  it("messages during a run produce one queued run that delivers everything unseen", async () => {
    const { thread } = await h.seed();
    const gate = deferred();
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (requests.length === 1) await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary(`reply ${requests.length}`),
        usage: [],
      });
    });

    const m1 = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "one",
    });
    const run1 = m1.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run1.id).status === "running",
      2000,
      "run1 running",
    );

    const m2 = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "two",
    });
    const m3 = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "three",
    });
    expect(m2.json.runs).toHaveLength(1);
    expect(m3.json.runs).toHaveLength(0);
    const run2 = m2.json.runs[0] as RunRecord;
    await nextTurn();
    expect(h.app.deskmates.ctx.runs.mustGet(run2.id).status).toBe("queued");
    expect(h.app.deskmates.ctx.runs.mustGet(run1.id).status).toBe("running");

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run2.id).status === "succeeded",
      3000,
      "run2 end",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(run1.id).status).toBe("succeeded");
    expect(requests).toHaveLength(2);
    const second = requests[1] as StartRunRequest;
    if (second.trigger.kind !== "thread_message") throw new Error("unreachable");
    // Unseen for run 2: "two" (seq 2), "three" (seq 3); the bot's own "reply 1" (seq 4) is not redelivered.
    expect(second.trigger.messages.map((m) => [m.seq, m.body])).toEqual([
      [2, "two"],
      [3, "three"],
    ]);
    const runs = await h.api<{ runs: RunRecord[] }>("GET", `/api/runs?threadId=${thread.id}`);
    expect(runs.json.runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    const members = h.app.deskmates.ctx.threads.members(thread.id);
    expect(members[0]?.lastSeenSeq).toBe(4);
  });
});

describe("usage across resumed sessions (ADR-0002 item 5)", () => {
  it("stores each run's delta, not the SDK's cumulative session totals", async () => {
    const { thread } = await h.seed();
    const counts = (n: number) => ({
      model: "test-model-default",
      inputTokens: n,
      outputTokens: n / 10,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    // The fake sidecar plays the SDK: resumed runs report the session's running total.
    const reports: { session: string; inputTokens: number }[] = [
      { session: "sess-1", inputTokens: 1000 },
      { session: "sess-1", inputTokens: 1500 },
      { session: "sess-2", inputTokens: 200 },
    ];
    let i = 0;
    h.provider.onRun(async (req, gw) => {
      const r = reports[i++];
      if (!r) throw new Error("unexpected run");
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        sdkSessionId: r.session,
        summary: summary("ok"),
        usage: [counts(r.inputTokens)],
      });
    });

    const ids: string[] = [];
    for (const body of ["one", "two", "three"]) {
      const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
        body,
      });
      const id = (m.json.runs[0] as RunRecord).id;
      ids.push(id);
      await waitFor(() => h.app.deskmates.ctx.runs.mustGet(id).status === "succeeded", 2000, body);
    }
    const inputs = ids.map(
      (id) => h.app.deskmates.ctx.usage.list(id as RunRecord["id"])[0]?.inputTokens,
    );
    expect(inputs).toEqual([1000, 500, 200]);
    const outputs = ids.map(
      (id) => h.app.deskmates.ctx.usage.list(id as RunRecord["id"])[0]?.outputTokens,
    );
    expect(outputs).toEqual([100, 50, 20]);
  });
});

describe("silent runs (ADR-0005 item 3)", () => {
  it("an empty reply ends the run as silent with no message row, and still advances last_seen_seq", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("   "),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "anyone?",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "silent",
      2000,
      "silent",
    );
    expect(h.app.deskmates.ctx.messages.list(thread.id)).toHaveLength(1);
    expect(h.app.deskmates.ctx.threads.members(thread.id)[0]?.lastSeenSeq).toBe(1);
  });
});

describe("a parked run holds its thread (ADR-0002 amendment 2)", () => {
  it("a queued run of the same bot and thread waits for it; another thread of the bot does not", async () => {
    // A parked run does not occupy its bot's lane (ADR-0005), but it still owns the
    // `(bot, thread)` SDK session it will resume, and two processes must never open one session.
    const { bot, workspace, thread } = await h.seed();
    const threadB = h.app.deskmates.ctx.threads.create({
      workspaceId: workspace.id,
      botIds: [bot.id],
    });
    const requests: StartRunRequest[] = [];
    let parked = false;
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.threadId === thread.id && req.attempt === 1 && !parked) {
        parked = true;
        await gw.post("approvals", {
          type: "approval_request",
          approvalId: "apr-hold",
          action: {
            toolName: "mcp__browser__browser_click",
            input: { element: "Submit", ref: "e3" },
            targetOrigin: "https://shop.example.test",
            argumentSummary: "click submit order",
            argumentPattern: "*submit*",
          },
          riskLevel: "L2",
          toolUseId: "toolu_1",
        });
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-hold",
          usage: [],
          pendingApprovalId: "apr-hold",
          pendingToolUseId: "toolu_1",
        });
        return;
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });

    // Nobody is online (no open SSE), so the request defers at once and the run parks.
    const first = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "buy the widget",
    });
    const parkedRun = first.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(parkedRun.id).status === "waiting_approval",
      2000,
      "parked",
    );

    // A second human message in the same thread queues a run that must not start.
    const second = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "and the other one too" },
    );
    const heldRun = second.json.runs[0] as RunRecord;
    for (let i = 0; i < 5; i++) {
      h.app.deskmates.scheduler.tick();
      h.app.deskmates.scheduler.kick();
      await nextTurn();
    }
    await h.app.deskmates.scheduler.drain();
    expect(h.app.deskmates.ctx.runs.mustGet(heldRun.id).status).toBe("queued");
    expect(h.provider.execCalls).toHaveLength(1);

    // The same bot in another thread is a different session and is unaffected.
    const elsewhere = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${threadB.id}/messages`,
      { body: "unrelated" },
    );
    const otherRun = elsewhere.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(otherRun.id).status === "succeeded",
      2000,
      "other thread ran",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(heldRun.id).status).toBe("queued");

    // The decision resumes the parked run; only when that has ended does the queued one start.
    await h.api("POST", "/api/approvals/apr-hold/decide", { decision: "allow_once" });
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(heldRun.id).status === "succeeded",
      3000,
      "held run ran",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(parkedRun.id).status).toBe("succeeded");
    // Parked process, the other thread's run, the resume, then the run that was held.
    expect(requests.map((r) => [r.threadId, r.attempt])).toEqual([
      [thread.id, 1],
      [threadB.id, 1],
      [thread.id, 2],
      [thread.id, 1],
    ]);
  });
});

describe("failure paths", () => {
  it("a run_ended the sidecar could only print to stdout (exit 3) still ends the run normally", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req) => {
      const ended = {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        sdkSessionId: "sess-fallback",
        summary: summary("recovered reply"),
        usage: [],
      };
      return {
        exitCode: 3,
        stdout: `ledger post failed: fetch failed\nRUN_ENDED ${JSON.stringify(ended)}\n`,
        stderr: "run_ended post failed: fetch failed",
      };
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "hello",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "end",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).summary?.reply).toBe("recovered reply");
    const msgs = await h.api<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${thread.id}/messages`,
    );
    expect(msgs.json.messages.at(-1)?.body).toBe("recovered reply");
  });

  it("a malformed RUN_ENDED line on stdout is ignored and the run fails as before", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async () => ({ exitCode: 3, stdout: "RUN_ENDED {not json\n", stderr: "" }));
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "hello",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).status === "failed", 2000, "fail");
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).error).toContain("exit 3");
  });

  it("a sidecar that exits without run_ended fails the run and does not advance last_seen_seq", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async () => ({ exitCode: 137, stderr: "killed" }));
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "hi",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "failed",
      2000,
      "failed",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).error).toMatch(/exit 137/);
    expect(h.app.deskmates.ctx.threads.members(thread.id)[0]?.lastSeenSeq).toBe(0);

    // The next wake redelivers the same slice (at-least-once).
    const seen: number[][] = [];
    h.provider.onRun(async (req, gw) => {
      if (req.trigger.kind === "thread_message") seen.push(req.trigger.messages.map((x) => x.seq));
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const m2 = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "again",
    });
    const run2 = m2.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run2.id).status === "succeeded",
      2000,
      "run2",
    );
    expect(seen).toEqual([[1, 2]]);
  });

  it("a sidecar past RUN_TIMEOUT_SECONDS is killed, the run failed, and the knob recorded on the run", async () => {
    await h.close();
    h = await startHarness({ runTimeoutSeconds: 1 });
    const { thread } = await h.seed();
    h.provider.onRun(() => new Promise((r) => setTimeout(r, 5000).unref()));
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "hang",
    });
    const run = m.json.runs[0] as RunRecord;
    expect(run.config).toMatchObject({ runTimeoutSeconds: 1 });
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).status === "failed", 2500, "fail");
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).error).toContain("RUN_TIMEOUT_SECONDS (1 s)");
    expect(h.provider.execCalls[0]?.req.timeoutMs).toBe(1000);
    // The lane is free again: the next message starts at once.
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const m2 = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "again",
    });
    const next = m2.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(next.id).status === "succeeded",
      2000,
      "next",
    );
  });

  it("a deferred run parks with the approval id and the deferred tool-use id in its resume payload", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-9",
        usage: [],
        pendingApprovalId: "apr-9",
        pendingToolUseId: "toolu_deferred_1",
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "buy it",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "park",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).resumePayload).toEqual({
      sdkSessionId: "sess-9",
      approvalId: "apr-9",
      toolUseId: "toolu_deferred_1",
    });
  });

  it("a run that cannot start is failed with its error and does not block the lane", async () => {
    const { bot, thread } = await h.seed();
    // An `approval` trigger only ever exists on a parked run being resumed; a queued one has no
    // thread and no resume payload, so `start()` throws.
    const stuck = h.app.deskmates.ctx.runs.create({
      botId: bot.id,
      lane: "interactive",
      triggerKind: "approval",
      triggerRef: "apr-nonexistent",
    });
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(stuck.id).status === "failed",
      2000,
      "fail",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(stuck.id).error).toContain("could not start run");

    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("hi"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "after",
    });
    const next = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(next.id).status === "succeeded",
      2000,
      "next",
    );
    expect(h.provider.execCalls).toHaveLength(1);
  });

  it("an approval_request with nobody online defers, and the sidecar's own events still land", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      const res = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-1",
        action: { toolName: "checkout", input: {} },
        riskLevel: "L2",
      });
      // No `/api/events` client is open in this test, so the broker does not burn the short wait.
      expect(await res.json()).toEqual({
        type: "approval_response",
        approvalId: "apr-1",
        decision: "defer",
        reason: "nobody online",
      });
      // The sidecar's "requested" event was batched and lands after the Gateway's own `posted`
      // event took the next ledger seq; it must still be stored, not dropped as a redelivery.
      const ts = new Date().toISOString();
      const late = await gw.post("events", [
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 1,
          kind: "approval",
          payload: { phase: "requested" },
          ts,
        },
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 2,
          kind: "approval",
          payload: { phase: "decided" },
          ts,
        },
      ]);
      expect(late.status).toBe(200);
      expect(await late.json()).toEqual({ stored: 2 });
      // The sidecar retries a batch whose response it did not see (issue #68); a batch the
      // Gateway already stored is dropped event by event, so a retry never duplicates the ledger.
      const again = await gw.post("events", [
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 1,
          kind: "approval",
          payload: { phase: "requested" },
          ts,
        },
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 2,
          kind: "approval",
          payload: { phase: "decided" },
          ts,
        },
      ]);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ stored: 0 });
      const huge = await gw.post("events", [
        { type: "event", runId: req.runId, attempt: 1, seq: 1e300, kind: "log", payload: {}, ts },
      ]);
      expect(huge.status).toBe(400);
      // An event from a process this run is not on is a stale sidecar, not a new attempt.
      const wrongAttempt = await gw.post("events", [
        { type: "event", runId: req.runId, attempt: 2, seq: 5, kind: "log", payload: {}, ts },
      ]);
      expect(wrongAttempt.status).toBe(400);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("asked and gave up"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "buy it",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
    const events = h.app.deskmates.ctx.events.list(run.id);
    expect(events.map((e) => [e.seq, e.kind, e.sidecarSeq])).toEqual([
      [1, "memory_index", undefined],
      [2, "approval", undefined],
      [3, "approval", 1],
      [4, "approval", 2],
    ]);
    expect(events[1]?.payload).toMatchObject({ phase: "posted", approvalId: "apr-1" });
    expect(events[2]?.payload).toMatchObject({ phase: "requested" });
  });

  it("internal routes reject a token that belongs to another run", async () => {
    const { thread } = await h.seed();
    const tokens: string[] = [];
    h.provider.onRun(async (req, gw) => {
      tokens.push(req.modelAuthToken);
      const wrong = await gw.post("events", [], "cbt_not_a_real_token");
      expect(wrong.status).toBe(401);
      const other = await fetch(`${req.gatewayBaseUrl}/internal/runs/run_other/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${req.modelAuthToken}`,
        },
        body: "[]",
      });
      expect(other.status).toBe(401);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "x",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
  });
});

describe("the sidecar is not trusted to send well-formed reports", () => {
  /**
   * Drives one run to `succeeded`, giving `script` the live internal routes while the run is
   * still open. Whatever the script posts is the sidecar's misbehaviour under test; the good
   * `ended` afterwards is what a well-behaved sidecar would have sent.
   */
  async function withRunningRun(
    body: string,
    script: (req: StartRunRequest, gw: FakeSidecarClient) => Promise<void>,
  ): Promise<{ run: RunRecord; thread: Thread }> {
    const { thread } = await h.seed();
    let scriptFinished = false;
    h.provider.onRun(async (req, gw) => {
      await script(req, gw);
      scriptFinished = true;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body,
    });
    const run = m.json.runs[0] as RunRecord;
    // An ended route commits status before its HTTP response reaches this test's script.
    // Wait for both, otherwise assertions can race the response bookkeeping above.
    await waitFor(
      () => scriptFinished && h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      body,
    );
    return { run, thread };
  }

  it("rejects a summary without a reply and a usage entry with a non-string model, writing nothing", async () => {
    let badSummary: { status: number; body: unknown } | undefined;
    let badUsage: { status: number; body: unknown } | undefined;
    let usageAfterReject: unknown[] = [];
    const { run } = await withRunningRun("report badly", async (req, gw) => {
      // `summary.reply` is missing: this used to reach `reply.trim()` and 500, after the usage
      // rows for the same report had already been written.
      const s = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: { done: "x" },
        usage: [
          {
            model: "test-model-default",
            inputTokens: 7,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
      });
      badSummary = { status: s.status, body: await s.json() };
      // `model` is a number: this used to be a NOT NULL constraint failure, i.e. a 500.
      const u = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("hi"),
        usage: [{ model: 5 }],
      });
      badUsage = { status: u.status, body: await u.json() };
      usageAfterReject = h.app.deskmates.ctx.usage.list(req.runId);
    });

    expect(badSummary?.status).toBe(400);
    expect(badSummary?.body).toMatchObject({ code: "validation" });
    expect(badUsage?.status).toBe(400);
    expect(badUsage?.body).toMatchObject({ code: "validation" });
    // Neither rejected report left a usage row behind.
    expect(usageAfterReject).toEqual([]);
    // The run was still `running` after both, so the real report below could still end it.
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).status).toBe("succeeded");
    expect(h.app.deskmates.ctx.usage.list(run.id)).toEqual([]);
  });

  it("defaults the summary's missing string arrays but rejects wrong types", async () => {
    let lenient: number | undefined;
    let strict: number | undefined;
    let stored: RunSummary | undefined;
    const { run } = await withRunningRun("arrays", async (req, gw) => {
      const bad = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: { done: "d", reply: "", filesChanged: [{ nested: true }] },
        usage: [],
      });
      strict = bad.status;
      const ok = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: { done: "d", reply: "done here" },
        usage: [],
      });
      lenient = ok.status;
      stored = h.app.deskmates.ctx.runs.mustGet(req.runId).summary;
    });
    expect(strict).toBe(400);
    expect(lenient).toBe(200);
    expect(stored).toEqual({
      done: "d",
      reply: "done here",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      learned: [],
    });
    // The run ended on the accepted report; the script's own `ended` was the second one.
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).status).toBe("succeeded");
  });

  it("rejects thread_post attachments that are not {name, mimeType, ref} strings", async () => {
    let bad: number | undefined;
    let good: number | undefined;
    const { thread } = await withRunningRun("attach", async (req, gw) => {
      const b = await gw.post("messages", {
        type: "post_message",
        runId: req.runId,
        tool: "thread_post",
        body: "see this",
        attachments: [42, { name: { nested: true } }, null],
      });
      bad = b.status;
      const g = await gw.post("messages", {
        type: "post_message",
        runId: req.runId,
        tool: "thread_post",
        body: "see this",
        attachments: [{ name: "shot.png", mimeType: "image/png", ref: "/work/shot.png" }],
      });
      good = g.status;
    });
    expect(bad).toBe(400);
    expect(good).toBe(201);
    const posted = h.app.deskmates.ctx.messages
      .list(thread.id)
      .filter((m) => m.attachments.length > 0);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.attachments).toEqual([
      { name: "shot.png", mimeType: "image/png", ref: "/work/shot.png" },
    ]);
  });

  it("leaves no usage row when `ended` fails partway through (one transaction)", async () => {
    const { bot, thread } = await h.seed();
    const gate = deferred();
    const running = deferred<StartRunRequest>();
    h.provider.onRun(async (req) => {
      running.resolve(req);
      await gate.promise;
      return { exitCode: 1, stderr: "gone" };
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "hi",
    });
    const run = m.json.runs[0] as RunRecord;
    await running.promise;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "running",
      2000,
      "running",
    );

    // Posting the bot's reply is the last write before the status moves; make it throw the way a
    // constraint would and nothing at all may survive.
    const spy = vi.spyOn(h.app.deskmates.ctx.router, "postFromRun").mockImplementation(() => {
      throw new Error("no such column: whatever");
    });
    expect(() =>
      h.app.deskmates.lifecycle.ended(run.id, {
        type: "run_ended",
        runId: run.id,
        outcome: "completed",
        sdkSessionId: "sess-partial",
        summary: summary("this reply never lands"),
        usage: [
          {
            model: "test-model-default",
            inputTokens: 11,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
      }),
    ).toThrow(/no such column/);
    spy.mockRestore();

    // Read everything the rolled-back attempt could have left behind, then let the run go: a
    // failing assertion below must not strand the sidecar and hang the teardown.
    const leftovers = {
      usage: h.app.deskmates.ctx.usage.list(run.id),
      session: h.app.deskmates.ctx.sessions.get(bot.id, thread.id),
      run: h.app.deskmates.ctx.runs.mustGet(run.id),
      messages: h.app.deskmates.ctx.messages.list(thread.id).length,
    };
    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "failed",
      2000,
      "failed",
    );

    expect(leftovers.usage).toEqual([]);
    expect(leftovers.session).toBeUndefined();
    expect(leftovers.run.status).toBe("running");
    expect(leftovers.run.sdkSessionId).toBeUndefined();
    // Only the human's message; the bot's reply never happened.
    expect(leftovers.messages).toBe(1);
  });
});

describe("sandbox lifecycle", () => {
  it("recreates a workspace container that vanished out of band and retries the run once", async () => {
    const { thread } = await h.seed();
    // What the provider raises for a container that is no longer there (`docker rm`).
    h.provider.execErrors.push(new DeskmatesError("not_found", "no such container: deskmates-ws"));
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("back up"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "are you there",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "retried run",
    );
    // The stale handle was forgotten, so `ensure` created a second container.
    expect(h.provider.created).toHaveLength(2);
    expect(h.provider.execCalls).toHaveLength(1);
  });

  it("retries once when the sandbox cannot be prepared, before any model call", async () => {
    // Testbox, 2026-09-29: an upgrade recreated a workspace whose new container never became
    // healthy; the run failed at once and nothing retried it, though no work had started.
    const { thread } = await h.seed();
    h.provider.createErrors.push(
      new DeskmatesError("sandbox_unavailable", "container not healthy after 90000ms", {
        reason: "not_ready",
      }),
    );
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ready now"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "progress?",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run after one sandbox retry",
    );
    expect(h.provider.created).toHaveLength(2);
    expect(h.provider.execCalls).toHaveLength(1);
  });

  it("fails the run when the sandbox cannot be prepared twice", async () => {
    const { thread } = await h.seed();
    for (let i = 0; i < 2; i++) {
      h.provider.createErrors.push(new DeskmatesError("sandbox_unavailable", `not healthy ${i}`));
    }
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "progress?",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "failed",
      2000,
      "run failed after the retry",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).error).toContain("not healthy 1");
    expect(h.provider.created).toHaveLength(2);
    expect(h.provider.execCalls).toHaveLength(0);
  });

  it("gives the container a memory ceiling from WORKSPACE_MEMORY_LIMIT_MB and records the knob", async () => {
    await h.close();
    h = await startHarness({ workspaceMemoryLimitMb: 512 });
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "x",
    });
    const run = m.json.runs[0] as RunRecord;
    expect(run.config).toMatchObject({ workspaceMemoryLimitMb: 512 });
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
    expect(h.provider.created[0]?.memoryLimitBytes).toBe(512 * 1024 * 1024);
  });

  it("gives the container a CPU ceiling from WORKSPACE_CPU_LIMIT, none at 0, and records the knob", async () => {
    for (const cores of [1.5, 0]) {
      await h.close();
      h = await startHarness({ workspaceCpuLimit: cores });
      const { thread } = await h.seed();
      h.provider.onRun(async (req, gw) => {
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary("ok"),
          usage: [],
        });
      });
      const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
        body: "x",
      });
      const run = m.json.runs[0] as RunRecord;
      // No run-concurrency cap is recorded as null (ADR-0022 amendment 5).
      expect(run.config).toMatchObject({
        workspaceCpuLimit: cores,
        workspaceMaxConcurrentRuns: null,
      });
      await waitFor(
        () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
        2000,
        "run",
      );
      expect(h.provider.created[0]?.cpuLimit).toBe(cores === 0 ? undefined : cores);
    }
  });
});

describe("HTTP API errors", () => {
  it("maps DeskmatesError codes to statuses with a {code, message, details} body", async () => {
    const nf = await h.api<{ code: string }>("GET", "/api/threads/thr_missing");
    expect(nf.status).toBe(404);
    expect(nf.json.code).toBe("not_found");
    // An unknown workspace is "not found" before any validation (ADR-0022 route guard); a real
    // one with no bots is a validation error.
    const unknown = await h.api<{ code: string }>("POST", "/api/threads", { workspaceId: "x" });
    expect(unknown.status).toBe(404);
    const { thread, workspace } = await h.seed();
    const bad = await h.api<{ code: string }>("POST", "/api/threads", {
      workspaceId: workspace.id,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("validation");
    const empty = await h.api<{ code: string }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "",
    });
    expect(empty.status).toBe(400);
  });

  it("never echoes an internal error's own message to the caller", async () => {
    const detail =
      "SQLITE_ERROR: no such column: workspaces.secret_column /srv/deskmates/gateway.db";
    vi.spyOn(h.app.deskmates.ctx.workspaces, "list").mockImplementation(() => {
      throw new Error(detail);
    });
    const res = await h.api<{ code: string; message: string; details: unknown }>(
      "GET",
      "/api/workspaces",
    );
    expect(res.status).toBe(500);
    expect(res.json.code).toBe("internal");
    expect(JSON.stringify(res.json)).not.toContain("secret_column");
    expect(JSON.stringify(res.json)).not.toContain("SQLITE_ERROR");
    expect(res.json.details).toEqual({});
  });

  it("rejects a thread whose bot belongs to another workspace (ADR-0005 item 11)", async () => {
    const { bot } = await h.seed();
    const ws2 = await h.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
      name: "ws-2",
    });
    const res = await h.api<{ code: string }>("POST", "/api/threads", {
      workspaceId: ws2.json.workspace.id,
      botIds: [bot.id],
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("validation");
  });
});

describe("security (test strategy §6)", () => {
  it("a dump of the database never contains the upstream model token", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "x",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
    const issued = h.provider.execCalls[0]?.request.modelAuthToken as string;

    const dump = h.app.deskmates.ctx.db.serialize();
    const text = dump.toString("latin1");
    expect(text).not.toContain(TEST_UPSTREAM_TOKEN);
    // The short-lived token is stored hashed, never in clear.
    expect(text).not.toContain(issued);
    expect(text).toContain("run_tokens");
  });

  it("the workspace egress allowlist reaches the container at creation (browser-level egress)", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "x",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
    // The image's entry point turns this into Chromium host-resolver rules, so the browser
    // cannot resolve anything outside the allowlist. Nothing model-related travels this way; the
    // only other value is the per-workspace noVNC password (ADR-0006, B4), minted at creation.
    const spec = h.provider.created[0];
    expect(Object.keys(spec?.env ?? {}).sort()).toEqual([
      "DESKMATES_DESKTOP_MODE",
      "DESKMATES_EGRESS_ALLOWLIST",
      "DESKMATES_VNC_PASSWORD",
      "DESKMATES_VNC_VIEW_PASSWORD",
    ]);
    expect(spec?.env.DESKMATES_EGRESS_ALLOWLIST).toBe("*.example.test");
    expect(spec?.env.DESKMATES_VNC_PASSWORD).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a dump of the database never contains a bot's webhook token", async () => {
    const ws = await h.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
      name: "ws-hooks",
    });
    const created = await h.api<{ bot: RunRecord; webhookToken: string }>("POST", "/api/bots", {
      name: "hooked",
      workspaceId: ws.json.workspace.id,
    });
    const text = h.app.deskmates.ctx.db.serialize().toString("latin1");
    expect(created.json.webhookToken).toMatch(/^whk_/);
    expect(text).not.toContain(created.json.webhookToken);
  });

  it("a dump of the database never contains an integration key, runtime token or admin token (ADR-0013 row 4)", async () => {
    const fake = new FakeIntegrationRuntime({
      baseUrl: "http://runtime.internal:3000",
      adminToken: "integration-admin-do-not-store-2b7e",
    });
    const keyed = await startHarness(
      {
        secretsKey: Buffer.alloc(32, 3).toString("base64"),
        integrationRuntime: {
          url: "http://runtime.internal:3000",
          adminToken: "integration-admin-do-not-store-2b7e",
        },
      },
      undefined,
      { integrationFetch: fake.fetch },
    );
    try {
      const ws = await keyed.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
        name: "ws-int",
      });
      await keyed.api("POST", "/api/integrations/providers", { service: "gitea" });
      const res = await keyed.api(
        "POST",
        `/api/integrations/workspaces/${ws.json.workspace.id}/connections/api-key`,
        { service: "gitea", connectionName: "main", apiKey: "integration-key-do-not-store-6f3a" },
      );
      expect(res.status).toBe(201);
      const runtimeToken = fake.tokenNamed(`deskmates-workspace-${ws.json.workspace.id}`)?.token;
      expect(runtimeToken).toMatch(/^oct_/);
      const text = keyed.app.deskmates.ctx.db.serialize().toString("latin1");
      for (const secret of [
        "integration-key-do-not-store-6f3a",
        "integration-admin-do-not-store-2b7e",
        runtimeToken as string,
      ])
        expect(text).not.toContain(secret);
      // The Gateway stores the connection's runtime id and its workspace, and a token reference.
      expect(text).toContain("integration_workspace_tokens");
    } finally {
      await keyed.close();
    }
  });

  it("a dump of the database never contains a connector's URL or credential (ADR-0012 row 8)", async () => {
    const keyed = await startHarness({ secretsKey: Buffer.alloc(32, 3).toString("base64") });
    try {
      const ws = await keyed.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
        name: "ws-conn",
      });
      const res = await keyed.api("POST", "/api/connectors", {
        workspaceId: ws.json.workspace.id,
        name: "tickets",
        url: "http://secret-host.connector.internal:9000/api",
        credential: "connector-cred-do-not-store-4b1d",
      });
      expect(res.status).toBe(201);
      const text = keyed.app.deskmates.ctx.db.serialize().toString("latin1");
      expect(text).not.toContain("secret-host.connector.internal");
      expect(text).not.toContain("connector-cred-do-not-store-4b1d");
    } finally {
      await keyed.close();
    }
  });
});

describe("background triggers (design v0.3 §3.4)", () => {
  it("runs a thread-less trigger with no thread tools and keeps its reply in the summary", async () => {
    const { bot, thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("the sweep found nothing"),
        usage: [],
      });
    });
    const run = h.app.deskmates.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "whk_direct",
      triggerPayload: { body: "ping" },
    });
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "the background run to end",
    );

    const ended = h.app.deskmates.ctx.runs.mustGet(run.id);
    // There is nowhere to post it, so the reply lives in the summary and the run is not `silent`.
    expect(ended.summary?.reply).toBe("the sweep found nothing");
    expect(ended.threadId).toBeUndefined();
    const request = h.provider.execCalls[0]?.request as StartRunRequest;
    expect(request.tools).toEqual(sidecarToolsFor(false, ended.config));
    expect(request.trigger).toEqual({ kind: "webhook", body: "ping" });
    const messages = await h.api<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${thread.id}/messages`,
    );
    expect(messages.json.messages).toEqual([]);
  });
});
