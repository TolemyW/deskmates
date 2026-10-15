// T1: the approval broker end to end (ADR-0002 amendment 2, rows A1, A2 and "2, resume"). The
// fake provider plays the sidecar over real HTTP: it posts the request, polls for the decision
// and parks with `run_ended(deferred)` exactly as the hook does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type ApprovalResponse,
  type RunSummary,
  type StartRunRequest,
  type ThreadMessage,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, nextTurn, openSse, startHarness, waitFor } from "../test-support/harness.js";

function summary(reply: string): RunSummary {
  return {
    done: "done",
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

const ACTION = {
  toolName: "mcp__browser__browser_click",
  input: { element: "the blue Submit order button", ref: "e17" },
  targetOrigin: "https://shop.example.test",
  argumentSummary: "click submit order",
  argumentPattern: "*submit*",
};

function requestBody(approvalId: string, toolUseId = "toolu_1"): Record<string, unknown> {
  return {
    type: "approval_request",
    approvalId,
    action: ACTION,
    riskLevel: "L2",
    toolUseId,
  };
}

/** Posts a message and returns the run it created. */
async function wake(h: Harness, threadId: string, body: string): Promise<RunRecord> {
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${threadId}/messages`, {
    body,
  });
  const run = m.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

async function endedDeferred(
  gw: FakeSidecarClient,
  req: StartRunRequest,
  approvalId: string,
  toolUseId = "toolu_1",
  currentOrigin?: string,
): Promise<void> {
  await gw.post("ended", {
    type: "run_ended",
    runId: req.runId,
    outcome: "deferred",
    sdkSessionId: "sess-parked",
    usage: [],
    pendingApprovalId: approvalId,
    pendingToolUseId: toolUseId,
    ...(currentOrigin === undefined ? {} : { currentOrigin }),
  });
}

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("live wait: a human is online (ADR-0002 amendment 2, A1)", () => {
  it("posts one system message, waits, and the decision releases the run", async () => {
    const { bot, thread } = await h.seed();
    const sse = await openSse(h.baseUrl, `?threadId=${thread.id}`);
    const gate = deferred();
    const marker = "MARKER-FROM-A-PAGE-b7a1";
    let requestStatus = 0;
    let polled: ApprovalResponse | undefined;

    h.provider.onRun(async (req, gw) => {
      // A tool result the run already saw. It must never reach the approval message.
      await gw.post("events", [
        {
          type: "event",
          runId: req.runId,
          attempt: req.attempt,
          seq: 1,
          kind: "tool_result",
          payload: { text: `checkout page says ${marker}` },
          ts: new Date().toISOString(),
        },
      ]);
      const res = await gw.post("approvals", requestBody("apr-live"));
      requestStatus = res.status;
      await gate.promise;
      const poll = await gw.get("approvals/apr-live");
      polled = (await poll.json()) as ApprovalResponse;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ordered"),
        usage: [],
      });
    });

    const run = await wake(h, thread.id, "please place the order");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval_live",
      2000,
      "live wait",
    );
    // The transition happens before the response is written, so wait for the sidecar to read it.
    await waitFor(() => requestStatus !== 0, 2000, "request answered");
    expect(requestStatus).toBe(202);

    // Exactly one `system` message, naming tool, origin and instruction, with the attachment.
    const messages = h.app.deskmates.ctx.messages
      .list(thread.id)
      .filter((m) => m.authorKind === "system");
    expect(messages).toHaveLength(1);
    const card = messages[0] as ThreadMessage;
    expect(card.body).toContain(ACTION.toolName);
    expect(card.body).toContain("https://shop.example.test");
    expect(card.body).toContain("click submit order");
    expect(card.body).toContain("please place the order");
    expect(card.body).not.toContain(marker);
    expect(card.attachments).toEqual([
      { name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: "apr-live" },
    ]);

    await waitFor(() => sse.events.some((e) => e.type === "approval"), 2000, "approval frame");

    const decided = await h.api<{ approval: Approval }>("POST", "/api/approvals/apr-live/decide", {
      decision: "allow_once",
    });
    expect(decided.status).toBe(200);
    expect(decided.json.approval.decidedBy).toBe("human:web");
    expect(decided.json.approval.waitMode).toBe("live");
    // The live wait is over: the run is running again before the sidecar's poll returns.
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).status).toBe("running");

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run end",
    );
    sse.close();
    expect(polled).toEqual({
      type: "approval_response",
      approvalId: "apr-live",
      decision: "allow",
    });

    const phases = h.app.deskmates.ctx.events
      .list(run.id)
      .filter((e) => e.kind === "approval")
      .map((e) => e.payload.phase);
    expect(phases).toEqual(["posted", "decided"]);
    // The request was posted for this bot's run and nobody else's.
    expect(h.app.deskmates.ctx.approvals.mustGet("apr-live" as Approval["id"]).botId).toBe(bot.id);
  });

  it("a duplicate request for the same approvalId answers the same way and posts nothing new", async () => {
    const { thread } = await h.seed();
    const sse = await openSse(h.baseUrl);
    const gate = deferred();
    const statuses: number[] = [];
    h.provider.onRun(async (req, gw) => {
      statuses.push((await gw.post("approvals", requestBody("apr-dup"))).status);
      statuses.push((await gw.post("approvals", requestBody("apr-dup"))).status);
      await gate.promise;
      statuses.push((await gw.post("approvals", requestBody("apr-dup"))).status);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "do it");
    await waitFor(() => statuses.length === 2, 2000, "two requests");
    expect(statuses).toEqual([202, 202]);
    expect(
      h.app.deskmates.ctx.messages.list(thread.id).filter((m) => m.authorKind === "system"),
    ).toHaveLength(1);

    const first = await h.api("POST", "/api/approvals/apr-dup/decide", { decision: "deny" });
    expect(first.status).toBe(200);
    // A second decision is a conflict, not a silent overwrite.
    const second = await h.api<{ code: string }>("POST", "/api/approvals/apr-dup/decide", {
      decision: "allow_once",
    });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("invalid_transition");

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "end",
    );
    sse.close();
    // The third request found a decided row and got the decision, still with one message.
    expect(statuses[2]).toBe(200);
    expect(
      h.app.deskmates.ctx.messages.list(thread.id).filter((m) => m.authorKind === "system"),
    ).toHaveLength(2); // the request card and the decision echo
  });
});

describe("defer and resume (ADR-0002 amendment 2, '2, resume')", () => {
  it("nobody online → defer → park → decide → one resumed process with attempt 2", async () => {
    const { thread } = await h.seed();
    const requests: StartRunRequest[] = [];
    const tokens: string[] = [];
    let deferResponse: unknown;
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      tokens.push(req.modelAuthToken);
      if (req.attempt === 1) {
        const res = await gw.post("approvals", requestBody("apr-park"));
        expect(res.status).toBe(200);
        deferResponse = await res.json();
        await endedDeferred(gw, req, "apr-park");
        return;
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("bought it"),
        usage: [],
      });
    });

    const run = await wake(h, thread.id, "buy the widget");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    expect(deferResponse).toEqual({
      type: "approval_response",
      approvalId: "apr-park",
      decision: "defer",
      reason: "nobody online",
    });
    expect(h.app.deskmates.ctx.approvals.mustGet("apr-park" as Approval["id"]).waitMode).toBe(
      "deferred",
    );

    // The parked run's token is gone with its process.
    const stale = await fetch(`${h.baseUrl}/internal/runs/${run.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[0]}` },
      body: "[]",
    });
    expect(stale.status).toBe(401);

    await h.api("POST", "/api/approvals/apr-park/decide", { decision: "allow_once" });
    await waitFor(() => requests.length === 2, 2000, "resume");
    const resumed = requests[1] as StartRunRequest;
    expect(resumed.attempt).toBe(2);
    expect(resumed.sdkSessionId).toBe("sess-parked");
    // No `currentOrigin` was reported with the park, so the trigger has no such key at all: the
    // resumed hook must not be told a wrong origin (ADR-0002 amendment 2, "2, stale snapshot").
    expect(resumed.trigger).toEqual({
      kind: "approval",
      approvalId: "apr-park",
      decision: "allow_once",
      toolUseId: "toolu_1",
      deferredAction: {
        toolName: ACTION.toolName,
        targetOrigin: ACTION.targetOrigin,
        argumentPattern: ACTION.argumentPattern,
      },
    });
    expect("currentOrigin" in resumed.trigger).toBe(false);
    expect(resumed.tools).toEqual(
      sidecarToolsFor(true, h.app.deskmates.ctx.runs.mustGet(run.id).config),
    );
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).attempt).toBe(2);

    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "resumed end",
    );
    const phases = h.app.deskmates.ctx.events
      .list(run.id)
      .filter((e) => e.kind === "approval")
      .map((e) => e.payload.phase);
    expect(phases).toEqual(["posted", "decided", "resumed"]);
  });

  it("hands the parked process's origin and the deferred action to the resumed one", async () => {
    // ADR-0002 amendment 2, "2, stale snapshot": the resumed process is a new MCP session, so it
    // knows neither the page it was on nor which call the decision was for until the trigger
    // tells it. `currentOrigin` comes from `run_ended(deferred)` through `resume_payload`;
    // `deferredAction` comes from the approval row, so a retry can be matched on it.
    const origin = "http://shop.example.test:8080";
    const { thread } = await h.seed();
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 1) {
        await gw.post("approvals", requestBody("apr-origin"));
        await endedDeferred(gw, req, "apr-origin", "toolu_9", origin);
        return;
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("clicked it"),
        usage: [],
      });
    });

    const run = await wake(h, thread.id, "submit the order");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).resumePayload).toEqual({
      sdkSessionId: "sess-parked",
      approvalId: "apr-origin",
      toolUseId: "toolu_9",
      currentOrigin: origin,
    });

    await h.api("POST", "/api/approvals/apr-origin/decide", { decision: "allow_once" });
    await waitFor(() => requests.length === 2, 2000, "resume");
    expect((requests[1] as StartRunRequest).trigger).toEqual({
      kind: "approval",
      approvalId: "apr-origin",
      decision: "allow_once",
      toolUseId: "toolu_9",
      currentOrigin: origin,
      deferredAction: {
        toolName: ACTION.toolName,
        targetOrigin: ACTION.targetOrigin,
        argumentPattern: ACTION.argumentPattern,
      },
    });
  });

  it("Gateway-originated events carry the run's attempt at the time they were appended", async () => {
    // ADR-0002 amendment 2, "2, resume": `resumed`, `decided` and rule changes are the Gateway's
    // own events; without the run's current attempt the ledger disagrees with itself.
    const { thread } = await h.seed();
    const gate = deferred();
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 1) {
        await gw.post("approvals", requestBody("apr-attempt"));
        await endedDeferred(gw, req, "apr-attempt");
        return;
      }
      // A second request, made by the resumed process, so its `posted` and `decided` events are
      // appended while the run is on attempt 2.
      await gw.post("approvals", requestBody("apr-attempt-2", "toolu_2"));
      await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done"),
        usage: [],
      });
    });

    const run = await wake(h, thread.id, "place it");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    await h.api("POST", "/api/approvals/apr-attempt/decide", { decision: "allow_once" });
    await waitFor(() => requests.length === 2, 2000, "resume");
    await waitFor(
      () => h.app.deskmates.ctx.approvals.get("apr-attempt-2" as Approval["id"]) !== undefined,
      2000,
      "second request",
    );
    await h.api("POST", "/api/approvals/apr-attempt-2/decide", { decision: "deny" });
    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "resumed end",
    );

    const approvals = h.app.deskmates.ctx.events
      .list(run.id)
      .filter((e) => e.kind === "approval")
      .map((e) => [e.payload.phase, e.payload.approvalId, e.attempt]);
    expect(approvals).toEqual([
      // Appended before any resume: the run was still on its first process.
      ["posted", "apr-attempt", 1],
      ["decided", "apr-attempt", 1],
      ["resumed", "apr-attempt", 2],
      ["posted", "apr-attempt-2", 2],
      ["decided", "apr-attempt-2", 2],
    ]);
  });

  it("a deny decision resumes the run with decision deny", async () => {
    const { thread } = await h.seed();
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 1) {
        await gw.post("approvals", requestBody("apr-deny"));
        await endedDeferred(gw, req, "apr-deny");
        return;
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("told them no"),
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "wire the money");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    await h.api("POST", "/api/approvals/apr-deny/decide", {
      decision: "deny",
      reason: "not this vendor",
    });
    await waitFor(() => requests.length === 2, 2000, "resume");
    expect((requests[1] as StartRunRequest).trigger).toMatchObject({
      kind: "approval",
      decision: "deny",
    });
    const approval = h.app.deskmates.ctx.approvals.mustGet("apr-deny" as Approval["id"]);
    expect(h.app.deskmates.ctx.broker.response(approval)).toEqual({
      type: "approval_response",
      approvalId: "apr-deny",
      decision: "deny",
      reason: "Denied by human: not this vendor",
    });
  });

  it("a decision that lands before run_ended still resumes the run exactly once", async () => {
    const { thread } = await h.seed();
    const sse = await openSse(h.baseUrl);
    const requests: StartRunRequest[] = [];
    const decided = deferred();
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 1) {
        await gw.post("approvals", requestBody("apr-race"));
        // The human answers while the hook is still in its short wait; the sidecar's own wait has
        // already given up by the time it notices, and it parks.
        await decided.promise;
        await endedDeferred(gw, req, "apr-race");
        return;
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done after the race"),
        usage: [],
      });
    });

    const run = await wake(h, thread.id, "ship it");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval_live",
      2000,
      "live",
    );
    await h.api("POST", "/api/approvals/apr-race/decide", { decision: "allow_once" });
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).status).toBe("running");
    decided.resolve();

    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "resumed end",
    );
    sse.close();
    expect(requests).toHaveLength(2);
    expect((requests[1] as StartRunRequest).attempt).toBe(2);
  });

  it("two scheduler passes over the same parked run produce one resume", async () => {
    const { thread } = await h.seed();
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 1) {
        await gw.post("approvals", requestBody("apr-twice"));
        await endedDeferred(gw, req, "apr-twice");
        return;
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("once"),
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "go");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    // Decide on the store directly so the route's own kick does not race the two ticks below.
    h.app.deskmates.ctx.broker.decide(
      "apr-twice" as Approval["id"],
      "allow_once",
      "human:operator",
    );
    h.app.deskmates.scheduler.tick();
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
    expect(requests).toHaveLength(2);
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).status).toBe("succeeded");
  });

  it("reconcile() after a restart leaves a parked run alone and then resumes it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-approval-"));
    const dbPath = join(dir, "gateway.db");
    await h.close();
    h = await startHarness({ dbPath });
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", requestBody("apr-restart"));
      await endedDeferred(gw, req, "apr-restart");
    });
    const run = await wake(h, thread.id, "renew the domain");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );

    // Stop the scheduler so the decision is recorded but nothing resumes before the restart.
    h.app.deskmates.scheduler.stop();
    await h.api("POST", "/api/approvals/apr-restart/decide", { decision: "allow_always" });
    await nextTurn();
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).status).toBe("waiting_approval");
    await h.close();

    h = await startHarness({ dbPath });
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("renewed"),
        usage: [],
      });
    });
    await waitFor(() => h.provider.execCalls.length === 1, 3000, "one resume");
    await h.app.deskmates.scheduler.drain();
    expect(h.provider.execCalls).toHaveLength(1);
    const resumed = h.provider.execCalls[0]?.request as StartRunRequest;
    expect(resumed.runId).toBe(run.id);
    expect(resumed.attempt).toBe(2);
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).status).toBe("succeeded");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reconcile() does not touch a parked run whose approval is still pending", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", requestBody("apr-pending"));
      await endedDeferred(gw, req, "apr-pending");
    });
    const run = await wake(h, thread.id, "wait for me");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    h.app.deskmates.scheduler.reconcile();
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
    const after = h.app.deskmates.ctx.runs.mustGet(run.id);
    expect(after.status).toBe("waiting_approval");
    expect(after.error).toBeUndefined();
    expect(h.provider.execCalls).toHaveLength(1);
  });
});

describe("usage survives a resume (ADR-0002 item 5)", () => {
  it("sums the parked attempt and the resumed one instead of overwriting", async () => {
    const { thread } = await h.seed();
    const model = "test-model-default";
    const spend = (inputTokens: number, outputTokens: number) => [
      { model, inputTokens, outputTokens, cacheReadTokens: 0, cacheCreateTokens: 0 },
    ];
    h.provider.onRun(async (req, gw) => {
      if (req.attempt === 1) {
        await gw.post("approvals", requestBody("apr-usage"));
        // The SDK reports the session's cumulative totals: 100 so far, on the session the
        // resumed process will continue from.
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-parked",
          usage: spend(100, 10),
          pendingApprovalId: "apr-usage",
          pendingToolUseId: "toolu_1",
        });
        return;
      }
      // Attempt 2 continues the same session, so 160 is the run's whole spend, not a correction
      // of the first attempt's 100.
      const first = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        sdkSessionId: "sess-parked",
        summary: summary("paid"),
        usage: spend(160, 16),
      });
      expect(first.status).toBe(200);
      // A redelivered `ended` for the same attempt is a conflict and changes nothing.
      const second = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        sdkSessionId: "sess-parked",
        summary: summary("paid"),
        usage: spend(160, 16),
      });
      expect(second.status).toBe(409);
    });

    const run = await wake(h, thread.id, "pay the invoice");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    expect(h.app.deskmates.ctx.usage.list(run.id)[0]?.inputTokens).toBe(100);

    await h.api("POST", "/api/approvals/apr-usage/decide", { decision: "allow_once" });
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "resumed end",
    );

    const view = await h.api<{ usage: { model: string; inputTokens: number }[] }>(
      "GET",
      `/api/runs/${run.id}`,
    );
    expect(view.json.usage).toHaveLength(1);
    expect(view.json.usage[0]).toMatchObject({ model, inputTokens: 160, outputTokens: 16 });
    // Two rows, one per attempt: 100 before the park and the 60 the resumed process added.
    expect(
      h.app.deskmates.ctx.usage.listByAttempt(run.id).map((r) => [r.attempt, r.inputTokens]),
    ).toEqual([
      [1, 100],
      [2, 60],
    ]);
  });
});

describe("the Gateway scrubs a secret-shaped action (design v0.3 §3.2)", () => {
  const TOKEN = "sk-live-abcdefghijklmnop";
  const COOKIE_VALUE = "abc123def456";
  const SECRET_ACTION = {
    toolName: "Bash",
    input: {
      command: `curl -H 'Authorization: Bearer ${TOKEN}' https://api.example.test/pay`,
      headers: { cookie: `sid=${COOKIE_VALUE}` },
    },
    targetOrigin: "https://api.example.test",
    argumentSummary: `curl -H 'Authorization: Bearer ${TOKEN}'`,
    argumentPattern: "*curl*",
  };

  it("keeps the token and the cookie out of the row, the thread and every event", async () => {
    const { thread } = await h.seed();
    // Posted straight at the internal route, so the sidecar's own redaction is bypassed exactly
    // as it would be by a sidecar whose copy of the patterns is old or broken.
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-secret",
        action: SECRET_ACTION,
        riskLevel: "L2",
        toolUseId: "toolu_1",
      });
      await endedDeferred(gw, req, "apr-secret");
    });
    const run = await wake(h, thread.id, "pay the vendor");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );

    const stored = await h.api<{ approval: Approval }>("GET", "/api/approvals/apr-secret");
    const card = h.app.deskmates.ctx.messages
      .list(thread.id)
      .filter((m) => m.authorKind === "system")[0] as ThreadMessage;
    const approvalPayloads = JSON.stringify(
      h.app.deskmates.ctx.events
        .list(run.id)
        .filter((e) => e.kind === "approval")
        .map((e) => e.payload),
    );
    const action = JSON.stringify(stored.json.approval.action);

    for (const surface of [action, card.body, JSON.stringify(card.attachments), approvalPayloads]) {
      expect(surface).not.toContain(TOKEN);
      expect(surface).not.toContain(COOKIE_VALUE);
    }
    expect(action).toContain("[redacted]");
    expect(card.body).toContain("[redacted]");
    expect(approvalPayloads).toContain("[redacted]");
    // The shape survives: the operator still sees it was a curl at that origin.
    expect(card.body).toContain("https://api.example.test");

    const guard = h.app.deskmates.ctx.events
      .list(run.id)
      .filter((e) => e.kind === "log" && e.payload.source === "approval_guard");
    expect(guard).toHaveLength(1);
    expect(guard[0]?.payload.redactedFields).toBe(3);
  });

  it("logs no guard event when the action carries nothing secret-shaped", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", requestBody("apr-clean"));
      await endedDeferred(gw, req, "apr-clean");
    });
    const run = await wake(h, thread.id, "click it");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    expect(
      h.app.deskmates.ctx.events
        .list(run.id)
        .filter((e) => e.kind === "log" && e.payload.source === "approval_guard"),
    ).toHaveLength(0);
    // A clean action is stored exactly as it was sent.
    expect(h.app.deskmates.ctx.approvals.mustGet("apr-clean" as Approval["id"]).action).toEqual(
      ACTION,
    );
  });
});

describe("a deny says who denied it", () => {
  it("prefixes a human's reason so the bot does not report it as the site refusing", async () => {
    const { thread } = await h.seed();
    const gate = deferred();
    let polled: ApprovalResponse | undefined;
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", requestBody("apr-reason"));
      await gate.promise;
      polled = (await (await gw.get("approvals/apr-reason")).json()) as ApprovalResponse;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("told them no"),
        usage: [],
      });
    });
    const sse = await openSse(h.baseUrl);
    const run = await wake(h, thread.id, "wire the money");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval_live",
      2000,
      "live wait",
    );
    await h.api("POST", "/api/approvals/apr-reason/decide", {
      decision: "deny",
      reason: "not today",
    });
    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run end",
    );
    sse.close();
    expect(polled).toEqual({
      type: "approval_response",
      approvalId: "apr-reason",
      decision: "deny",
      reason: "Denied by human: not today",
    });
  });

  it("names the rule when a stored deny rule answered", async () => {
    const { bot, thread } = await h.seed();
    const rule = h.app.deskmates.ctx.rules.create({
      botId: bot.id,
      matcher: { toolName: ACTION.toolName },
      decision: "deny",
      createdBy: "human:operator",
    });
    let answer: ApprovalResponse | undefined;
    h.provider.onRun(async (req, gw) => {
      const res = await gw.post("approvals", requestBody("apr-rule"));
      answer = (await res.json()) as ApprovalResponse;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("blocked"),
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "click submit");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run end",
    );
    expect(answer).toEqual({
      type: "approval_response",
      approvalId: "apr-rule",
      decision: "deny",
      reason: `Denied by rule ${rule.id}`,
    });
  });
});

describe("approval_decide refuses self-approval and Always from a bot (ADR-0002 amendment 3, A10)", () => {
  async function twoBotThread(): Promise<{ a: string; b: string; threadId: string }> {
    const ws = await h.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
      name: "ws-a10",
    });
    const a = await h.api<{ bot: { id: string } }>("POST", "/api/bots", {
      name: "ana",
      role: "worker",
      workspaceId: ws.json.workspace.id,
    });
    const b = await h.api<{ bot: { id: string } }>("POST", "/api/bots", {
      name: "bo",
      role: "approver",
      workspaceId: ws.json.workspace.id,
    });
    const thread = await h.api<{ thread: { id: string } }>("POST", "/api/threads", {
      workspaceId: ws.json.workspace.id,
      botIds: [a.json.bot.id, b.json.bot.id],
    });
    return { a: a.json.bot.id, b: b.json.bot.id, threadId: thread.json.thread.id };
  }

  const decide = (approvalId: string, runId: string, decision: string) => ({
    type: "approval_decide",
    runId,
    approvalId,
    decision,
  });

  it("refuses the requesting run deciding its own request and leaves it pending", async () => {
    const { thread } = await h.seed();
    let refused:
      | { status: number; code: string | undefined; refusal: string | undefined }
      | undefined;
    h.provider.onRun(async (req, gw) => {
      if (req.trigger.kind === "approval") {
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary(""),
          usage: [],
        });
        return;
      }
      await gw.post("approvals", requestBody("apr-self"));
      const res = await gw.post(
        "approvals/apr-self/decide",
        decide("apr-self", req.runId, "allow_once"),
      );
      const body = (await res.json()) as { code?: string; details?: { refusal?: string } };
      refused = { status: res.status, code: body.code, refusal: body.details?.refusal };
      await endedDeferred(gw, req, "apr-self");
    });

    const run = await wake(h, thread.id, "please place the order");
    await waitFor(() => refused !== undefined, 3000, "self decision");
    expect(refused).toEqual({ status: 403, code: "forbidden", refusal: "self_approval" });
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "parked",
    );
    expect(h.app.deskmates.ctx.approvals.mustGet("apr-self" as Approval["id"]).decision).toBe(
      undefined,
    );
  });

  it("refuses allow_always from a member bot, which may still allow once", async () => {
    const { a, b, threadId } = await twoBotThread();
    const statuses: number[] = [];
    h.provider.onRun(async (req, gw) => {
      const end = () =>
        gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary(""),
          usage: [],
        });
      if (req.botId === a) {
        if (req.trigger.kind === "approval") return void (await end());
        await gw.post("approvals", requestBody("apr-member"));
        await endedDeferred(gw, req, "apr-member");
        return;
      }
      if (req.botId === b && statuses.length === 0) {
        for (const decision of ["allow_always", "allow_once"]) {
          const res = await gw.post(
            "approvals/apr-member/decide",
            decide("apr-member", req.runId, decision),
          );
          statuses.push(res.status);
        }
      }
      await end();
    });

    await wake(h, threadId, "@ana place the order");
    // The request wakes nobody (amendment 3, A4); a human asks Bo to decide it.
    await waitFor(
      () => h.app.deskmates.ctx.approvals.get("apr-member" as Approval["id"]) !== undefined,
      3000,
      "request",
    );
    await wake(h, threadId, "@bo decide the pending approval");
    await waitFor(() => statuses.length === 2, 3000, "member decisions");
    expect(statuses).toEqual([403, 200]);
    const approval = h.app.deskmates.ctx.approvals.mustGet("apr-member" as Approval["id"]);
    expect(approval).toMatchObject({ decision: "allow_once", decidedBy: `bot:${b}` });
    expect(h.app.deskmates.ctx.rules.list(a as Approval["botId"])).toEqual([]);
  });
});

describe("unclassified and subagent labels (ADR-0002 amendment 3, A5)", () => {
  it("keeps the labels on the row, names them on the card and in the posted event", async () => {
    const { thread } = await h.seed();
    let status = 0;
    h.provider.onRun(async (req, gw) => {
      if (req.trigger.kind === "approval") {
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary(""),
          usage: [],
        });
        return;
      }
      const res = await gw.post("approvals", {
        type: "approval_request",
        approvalId: "apr-label",
        action: {
          toolName: "BrandNewTool",
          input: { x: 1 },
          argumentSummary: '{"x":1}',
          agentType: "Explore",
          unclassified: true,
        },
        riskLevel: "L2",
        toolUseId: "toolu_label",
      });
      status = res.status;
      await endedDeferred(gw, req, "apr-label", "toolu_label");
    });

    const run = await wake(h, thread.id, "try the new tool");
    await waitFor(() => status !== 0, 3000, "request");
    expect(status).toBe(200);
    const approval = h.app.deskmates.ctx.approvals.mustGet("apr-label" as Approval["id"]);
    expect(approval.action).toMatchObject({ agentType: "Explore", unclassified: true });
    const card = h.app.deskmates.ctx.messages
      .list(thread.id as ThreadMessage["threadId"])
      .find((m) => m.authorKind === "system");
    expect(card?.body).toContain("unclassified tool");
    expect(card?.body).toContain("inside a subagent of type Explore");
    const posted = h.app.deskmates.ctx.events
      .list(run.id)
      .find((e) => e.kind === "approval" && e.payload.phase === "posted");
    expect(posted?.payload).toMatchObject({ unclassified: true, agentType: "Explore" });
  });

  it("a request without labels has none on the card or the event", async () => {
    const { thread } = await h.seed();
    let status = 0;
    h.provider.onRun(async (req, gw) => {
      if (req.trigger.kind === "approval") {
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary(""),
          usage: [],
        });
        return;
      }
      status = (await gw.post("approvals", requestBody("apr-plain"))).status;
      await endedDeferred(gw, req, "apr-plain");
    });
    const run = await wake(h, thread.id, "place the order");
    await waitFor(() => status !== 0, 3000, "request");
    const card = h.app.deskmates.ctx.messages
      .list(thread.id as ThreadMessage["threadId"])
      .find((m) => m.authorKind === "system");
    expect(card?.body).not.toContain("unclassified");
    expect(card?.body).not.toContain("subagent");
    const posted = h.app.deskmates.ctx.events
      .list(run.id)
      .find((e) => e.kind === "approval" && e.payload.phase === "posted");
    expect(posted?.payload.unclassified).toBeUndefined();
    expect(posted?.payload.agentType).toBeUndefined();
  });

  it("rejects wrong-typed labels", async () => {
    const { thread } = await h.seed();
    const statuses: number[] = [];
    h.provider.onRun(async (req, gw) => {
      for (const extra of [{ agentType: 7 }, { unclassified: "yes" }, { unclassified: false }]) {
        const res = await gw.post("approvals", {
          type: "approval_request",
          approvalId: `apr-bad-${statuses.length}`,
          action: { ...ACTION, ...extra },
          riskLevel: "L2",
        });
        statuses.push(res.status);
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary(""),
        usage: [],
      });
    });
    await wake(h, thread.id, "place the order");
    await waitFor(() => statuses.length === 3, 3000, "requests");
    expect(statuses).toEqual([400, 400, 400]);
  });
});
