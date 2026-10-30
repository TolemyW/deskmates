// T1: the upgrade drain (ADR-0029 decisions 1 to 3) on the in-process harness and the fake
// provider. In drain the scheduler starts and resumes nothing while every trigger is still
// recorded; a live run hears of the drain on its next event batch and parks at its next safe
// point as `waiting_platform`; ending the drain starts the queue and resumes what the drain parked.

import type {
  ApprovalResponse,
  RunEnded,
  RunId,
  RuntimeStatus,
  SidecarEventsAck,
  StartRunRequest,
  Thread,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashWebhookToken, newWebhookToken } from "../bots/webhook-token.js";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, nextTurn, openSse, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const ACTION = {
  toolName: "mcp__browser__browser_click",
  input: { element: "Submit order", ref: "e17" },
  targetOrigin: "https://shop.example.test",
  argumentSummary: "click submit order",
  argumentPattern: "*submit*",
};

function summary(reply: string) {
  return {
    done: "done",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  };
}

async function finish(gw: FakeSidecarClient, req: StartRunRequest, reply = "ok"): Promise<void> {
  const res = await gw.post("ended", {
    type: "run_ended",
    runId: req.runId,
    outcome: "completed",
    usage: [],
    summary: summary(reply),
  });
  if (res.status !== 200) throw new Error(`ended returned ${res.status}`);
}

async function wake(thread: Thread, body: string): Promise<RunRecord> {
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body,
  });
  const run = m.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

async function event(gw: FakeSidecarClient, req: StartRunRequest, seq: number) {
  const res = await gw.post("events", [
    {
      type: "event",
      runId: req.runId,
      attempt: req.attempt,
      seq,
      kind: "log",
      payload: { source: "test", seq },
      ts: new Date().toISOString(),
    },
  ]);
  return (await res.json()) as SidecarEventsAck;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("drain stops launching and keeps accepting (decision 1)", () => {
  it("records every trigger, starts and resumes nothing, and starts it all when the drain ends", async () => {
    const { bot, thread } = await h.seed();
    const { ctx, scheduler, cron } = h.app.deskmates;
    ctx.bots.update(bot.id, { cron: [{ schedule: "* * * * *", prompt: "sweep" }] });
    const token = newWebhookToken();
    ctx.bots.setWebhookTokenHash(bot.id, hashWebhookToken(token));

    // A run parked on an approval before the drain: deciding it during the drain resumes nothing.
    h.provider.onRun(async (req, gw) => {
      if (req.attempt === 1 && req.trigger.kind === "thread_message") {
        await gw.post("approvals", {
          type: "approval_request",
          approvalId: "apr-drain-1",
          action: ACTION,
          riskLevel: "L2",
          toolUseId: "toolu_1",
        });
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-parked",
          usage: [],
          pendingApprovalId: "apr-drain-1",
          pendingToolUseId: "toolu_1",
        });
        return;
      }
      await finish(gw, req);
    });
    const parked = await wake(thread, "buy it");
    await waitFor(
      () => ctx.runs.mustGet(parked.id).status === "waiting_approval",
      3000,
      "the run to park on its approval",
    );
    await scheduler.drain();
    const execsBefore = h.provider.execCalls.length;

    const started = await h.api<RuntimeStatus>("POST", "/api/runtime/drain");
    expect(started.status).toBe(200);
    expect(started.json.draining).toBe(true);
    expect(started.json.drainStartedAt).toBeDefined();

    // Every trigger kind lands its row and decision as usual.
    const decided = await h.api("POST", "/api/approvals/apr-drain-1/decide", {
      decision: "allow_once",
    });
    expect(decided.status).toBe(200);
    expect(ctx.approvals.get("apr-drain-1" as never)?.decision).toBe("allow_once");
    const other = ctx.threads.create({ workspaceId: bot.workspaceId, botIds: [bot.id] });
    const human = await wake(other, "a message during the drain");
    const hook = await fetch(`${h.baseUrl}/hooks/${bot.id}/${token}`, {
      method: "POST",
      body: "a webhook during the drain",
    });
    expect(hook.status).toBeLessThan(300);
    cron.tick(new Date());
    const cronRun = ctx.runs.list({ botId: bot.id }).find((r) => r.triggerKind === "cron");
    const webhookRun = ctx.runs.list({ botId: bot.id }).find((r) => r.triggerKind === "webhook");
    expect(cronRun?.status).toBe("queued");
    expect(cronRun?.config.queuedInDrain).toBe(true);
    expect(webhookRun?.status).toBe("queued");
    expect(ctx.runs.mustGet(human.id).status).toBe("queued");

    scheduler.tick();
    scheduler.tick();
    await nextTurn();
    expect(h.provider.execCalls).toHaveLength(execsBefore);
    expect(ctx.runs.mustGet(parked.id).status).toBe("waiting_approval");
    expect((await h.api<RuntimeStatus>("GET", "/api/runtime")).json.draining).toBe(true);

    const ended = await h.api<RuntimeStatus>("DELETE", "/api/runtime/drain");
    expect(ended.json.draining).toBe(false);
    for (const id of [parked.id, human.id, cronRun?.id, webhookRun?.id] as RunId[])
      await waitFor(
        () =>
          ctx.runs.mustGet(id).status === "succeeded" || ctx.runs.mustGet(id).status === "silent",
        5000,
        `run ${id} to finish after the drain`,
      );
    expect(ctx.runs.mustGet(parked.id).attempt).toBe(2);
  });
});

describe("an active run parks at its next safe point (decision 2)", () => {
  it("defers on the acknowledgement's signal, releases lane and token, and resumes once after the drain", async () => {
    const { bot, thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    const workspaceId = bot.workspaceId;
    const reached = gate();
    const drainSeen = gate();
    let ack: SidecarEventsAck | undefined;
    let oldToken = "";
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 1) {
        oldToken = req.modelAuthToken;
        await gw.post("browser-lock", { type: "browser_lock", runId: req.runId, op: "acquire" });
        expect((await event(gw, req, 1)).drain).toBeUndefined();
        reached.open();
        await drainSeen.wait;
        // The next batch's acknowledgement carries the drain; the hook's next call defers.
        ack = await event(gw, req, 2);
        const ended: RunEnded = {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-drain",
          usage: [],
          pendingToolUseId: "toolu_next",
          platformInterruption: { interruption: "platform", reason: "drain" },
        };
        const res = await gw.post("ended", ended);
        if (res.status !== 200) throw new Error(`ended returned ${res.status}`);
        return;
      }
      await finish(gw, req, "resumed and done");
    });
    const run = await wake(thread, "long task");
    await reached.wait;
    expect(ctx.locks.list(workspaceId).map((lock) => lock.holderRunId)).toEqual([run.id]);
    expect((await h.api<RuntimeStatus>("POST", "/api/runtime/drain")).json.activeRuns).toBe(1);
    drainSeen.open();
    await waitFor(
      () => ctx.runs.mustGet(run.id).status === "waiting_platform",
      3000,
      "the run to park for the platform",
    );
    await scheduler.drain();
    expect(ack?.drain).toBe(true);
    const parked = ctx.runs.mustGet(run.id);
    expect(parked.resumePayload).toMatchObject({
      sdkSessionId: "sess-drain",
      platform: "drain",
      toolUseId: "toolu_next",
    });
    expect(ctx.runs.laneBusy(bot.id, "interactive")).toBe(false);
    expect(ctx.locks.list(workspaceId)).toEqual([]);
    expect(ctx.tokens.verify(oldToken)).toBeUndefined();
    const status = (await h.api<RuntimeStatus>("GET", "/api/runtime")).json;
    expect(status.activeRuns).toBe(0);
    expect(status.drainParkedRunIds).toEqual([run.id]);
    // Parking posts nothing in the thread (decision 7).
    expect(ctx.messages.list(thread.id, 0).filter((m) => m.authorKind === "system")).toHaveLength(
      0,
    );

    scheduler.tick();
    await nextTurn();
    expect(requests).toHaveLength(1);

    await h.api("DELETE", "/api/runtime/drain");
    await waitFor(() => ctx.runs.mustGet(run.id).status === "succeeded", 3000, "the resume");
    await scheduler.drain();
    expect(requests).toHaveLength(2);
    const resumed = requests[1] as StartRunRequest;
    expect(resumed.attempt).toBe(2);
    expect(resumed.sdkSessionId).toBe("sess-drain");
    expect(resumed.trigger).toEqual({ kind: "platform_resume", reason: "drain" });
    expect(resumed.modelAuthToken).not.toBe(oldToken);
    expect(ctx.runs.mustGet(run.id).config.platformResumes).toBe(1);
  });

  it("ends a live approval wait as defer, keeps the approval pending, then waits on it", async () => {
    const { thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    // Somebody is online, so the broker asks and the hook waits live.
    const sse = await openSse(h.baseUrl);
    const polled = gate();
    let poll: ApprovalResponse | undefined;
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 1) {
        const asked = await gw.post("approvals", {
          type: "approval_request",
          approvalId: "apr-live",
          action: ACTION,
          riskLevel: "L2",
          toolUseId: "toolu_buy",
        });
        expect(asked.status).toBe(202);
        await polled.wait;
        poll = (await (await gw.get("approvals/apr-live")).json()) as ApprovalResponse;
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-live",
          usage: [],
          pendingApprovalId: "apr-live",
          pendingToolUseId: "toolu_buy",
          platformInterruption: { interruption: "platform", reason: "drain" },
        });
        return;
      }
      await finish(gw, req, "bought");
    });
    try {
      const run = await wake(thread, "buy it");
      await waitFor(
        () => ctx.runs.mustGet(run.id).status === "waiting_approval_live",
        3000,
        "the live wait",
      );
      await h.api("POST", "/api/runtime/drain");
      polled.open();
      await waitFor(
        () => ctx.runs.mustGet(run.id).status === "waiting_platform",
        3000,
        "the drained park",
      );
      expect(poll).toMatchObject({ decision: "defer", platform: "drain", approvalId: "apr-live" });
      expect(ctx.approvals.get("apr-live" as never)?.decision).toBeUndefined();

      // The drain ends; nobody has decided: the run waits on its approval, nothing starts.
      await h.api("DELETE", "/api/runtime/drain");
      await waitFor(
        () => ctx.runs.mustGet(run.id).status === "waiting_approval",
        3000,
        "the run to wait on its approval",
      );
      await scheduler.drain();
      expect(requests).toHaveLength(1);

      await h.api("POST", "/api/approvals/apr-live/decide", { decision: "allow_once" });
      await waitFor(() => ctx.runs.mustGet(run.id).status === "succeeded", 3000, "the resume");
      await scheduler.drain();
      expect(requests).toHaveLength(2);
      expect(requests[1]?.trigger).toMatchObject({
        kind: "approval",
        approvalId: "apr-live",
        decision: "allow_once",
        toolUseId: "toolu_buy",
      });
    } finally {
      sse.close();
    }
  });

  it("a run that ends on its own during the drain ends normally", async () => {
    const { thread } = await h.seed();
    const { ctx } = h.app.deskmates;
    const go = gate();
    h.provider.onRun(async (req, gw) => {
      await go.wait;
      await finish(gw, req, "finished anyway");
    });
    const run = await wake(thread, "short task");
    await waitFor(() => ctx.runs.mustGet(run.id).status === "running", 3000, "running");
    await h.api("POST", "/api/runtime/drain");
    go.open();
    await waitFor(() => ctx.runs.mustGet(run.id).status === "succeeded", 3000, "its own end");
    expect((await h.api<RuntimeStatus>("GET", "/api/runtime")).json.drainParkedRunIds).toEqual([]);
  });
});

it("keeps both pending cards through a drain and resumes on the non-primary decision", async () => {
  const { thread } = await h.seed();
  const { ctx } = h.app.deskmates;
  const sse = await openSse(h.baseUrl);
  const parked = gate();
  const requests: StartRunRequest[] = [];
  h.provider.onRun(async (req, gw) => {
    requests.push(req);
    if (req.attempt === 1) {
      for (const [id, call] of [
        ["apr-one", "call_a"],
        ["apr-two", "call_b"],
      ]) {
        await gw.post("approvals", {
          type: "approval_request",
          approvalId: id,
          toolUseId: call,
          action: ACTION,
          riskLevel: "L2",
        });
      }
      await parked.wait;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-multi",
        usage: [],
        pendingApprovalId: "apr-one",
        pendingApprovalIds: ["apr-one", "apr-two"],
        pendingToolUseId: "call_a",
        platformInterruption: { interruption: "platform", reason: "drain" },
      });
      return;
    }
    expect(req.pendingApprovals).toEqual([
      expect.objectContaining({ approvalId: "apr-one", toolUseId: "call_a", kind: "tool" }),
    ]);
    const response = await gw.post("approvals", {
      type: "approval_request",
      approvalId: "apr-one",
      toolUseId: "call_a",
      action: ACTION,
      riskLevel: "L2",
    });
    expect(response.status).toBe(202);
    await finish(gw, req);
  });
  try {
    const run = await wake(thread, "two actions");
    await waitFor(() => ctx.approvals.forRun(run.id).length === 2, 3000, "two cards");
    await h.api("POST", "/api/runtime/drain");
    parked.open();
    await waitFor(() => ctx.runs.mustGet(run.id).status === "waiting_platform", 3000, "parked");
    expect(ctx.runs.mustGet(run.id).resumePayload?.approvalIds).toEqual(["apr-one", "apr-two"]);
    await h.api("POST", "/api/approvals/apr-two/decide", { decision: "allow_once" });
    await h.api("DELETE", "/api/runtime/drain");
    await waitFor(() => ctx.runs.mustGet(run.id).status === "succeeded", 3000, "resumed");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.trigger).toMatchObject({
      kind: "approval",
      approvalId: "apr-two",
      toolUseId: "call_b",
    });
    expect(ctx.approvals.forRun(run.id)).toHaveLength(2);
  } finally {
    sse.close();
  }
});
