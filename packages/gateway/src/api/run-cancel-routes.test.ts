// T1: `POST /api/runs/:id/cancel` (issue #15). A non-terminal run moves to `cancelled`, its lane is
// free for the next run, its token stops working, a `run_status` frame goes out, its pending
// approvals are closed so they leave every inbox, and a live sidecar process is killed after the
// grace window. A terminal run is a 409 that writes nothing.

import type { Approval, RunId, ThreadMessage } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../events/bus.js";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { snapshotDatabase } from "../test-support/tenants.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function wake(h: Harness, threadId: string, body: string): Promise<RunRecord> {
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${threadId}/messages`, {
    body,
  });
  const run = m.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

let h: Harness;
let release: () => void;

beforeEach(async () => {
  h = await startHarness();
  release = () => {};
});

afterEach(async () => {
  release();
  await h.close();
});

describe("POST /api/runs/:id/cancel", () => {
  it("cancels a running run, revokes its token, publishes run_status and kills the sidecar after the grace window", async () => {
    const { thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    scheduler.cancelGraceMs = 20;
    const hold = deferred();
    release = hold.resolve;
    let token = "";
    let post: ((path: string, body: unknown) => Promise<Response>) | undefined;
    h.provider.onRun(async (req, gw) => {
      token = req.modelAuthToken;
      post = (path, body) => gw.post(path, body);
      // A sidecar that never ends on its own.
      await hold.promise;
    });
    const frames: GatewayEvent[] = [];
    const unsubscribe = ctx.bus.subscribe((event) => frames.push(event));
    const run = await wake(h, thread.id, "work for a long time");
    await waitFor(() => token !== "", 3000, "sidecar started");
    expect(ctx.runs.mustGet(run.id).status).toBe("running");
    expect(scheduler.activeAttempts(ctx.bots.mustGet(run.botId).workspaceId)).toBe(1);

    const res = await h.api<{ run: RunRecord }>("POST", `/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.json.run.status).toBe("cancelled");
    expect(ctx.runs.mustGet(run.id).status).toBe("cancelled");
    expect(ctx.runs.mustGet(run.id).finishedAt).toBeDefined();
    expect(
      frames.some(
        (e) => e.type === "run_status" && e.run.id === run.id && e.run.status === "cancelled",
      ),
    ).toBe(true);
    unsubscribe();

    // The stop request: the run's token no longer opens any internal route.
    const refused = await post?.("events", {
      type: "event",
      runId: run.id,
      kind: "log",
      attempt: 1,
      payload: {},
    });
    expect(refused?.status).toBe(401);

    // The process ignored the stop; past the grace window the provider is told to kill it.
    const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
    await waitFor(() => scheduler.activeAttempts(workspaceId) === 0, 3000, "sidecar killed");
    expect(h.provider.execCalls[0]?.req.signal?.aborted).toBe(true);
    // The exec ending without run_ended must not turn the cancelled run into a failed one.
    expect(ctx.runs.mustGet(run.id).status).toBe("cancelled");
    expect(ctx.events.list(run.id).some((e) => e.payload.source === "cancel")).toBe(true);
  });

  it("answers a terminal run with 409 and its status, and writes nothing", async () => {
    const { thread } = await h.seed();
    const { ctx } = h.app.deskmates;
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "quick one");
    await waitFor(() => ctx.runs.mustGet(run.id).status === "silent", 3000, "run ended");
    await h.app.deskmates.scheduler.drain();
    const before = snapshotDatabase(ctx);
    const res = await h.api<{ code: string; details: { status: string } }>(
      "POST",
      `/api/runs/${run.id}/cancel`,
    );
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("invalid_transition");
    expect(res.json.details.status).toBe("silent");
    expect(snapshotDatabase(ctx)).toBe(before);
  });

  it("is a 404 for a run that does not exist", async () => {
    const res = await h.api<{ code: string }>("POST", "/api/runs/run_missing/cancel");
    expect(res.status).toBe(404);
  });

  it("cancels a parked run with no sidecar and closes its pending approval", async () => {
    const { thread } = await h.seed();
    const { ctx } = h.app.deskmates;
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-cancel",
        action: {
          toolName: "mcp__browser__browser_click",
          input: { element: "submit", ref: "e1" },
          targetOrigin: "https://shop.example.test",
          argumentSummary: "click submit",
        },
        riskLevel: "L2",
      });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-cancel",
        usage: [],
        pendingApprovalId: "apr-cancel",
      });
    });
    const run = await wake(h, thread.id, "buy it");
    await waitFor(() => ctx.runs.mustGet(run.id).status === "waiting_approval", 3000, "run parked");
    await h.app.deskmates.scheduler.drain();
    const pending = await h.api<{ approvals: Approval[] }>("GET", "/api/approvals");
    expect(pending.json.approvals.map((a) => a.id)).toEqual(["apr-cancel"]);
    const execs = h.provider.execCalls.length;

    const res = await h.api<{ run: RunRecord }>("POST", `/api/runs/${run.id}/cancel`, {
      authorId: "ops",
    });
    expect(res.status).toBe(200);
    expect(res.json.run.status).toBe("cancelled");

    const after = await h.api<{ approvals: Approval[] }>("GET", "/api/approvals");
    expect(after.json.approvals).toEqual([]);
    const closed = ctx.approvals.mustGet("apr-cancel" as Approval["id"]);
    expect(closed.decision).toBe("deny");
    expect(closed.decidedBy).toBe("system:cancel");
    expect(closed.reason).toContain("human:ops");
    const messages = await h.api<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${thread.id}/messages`,
    );
    expect(messages.json.messages.at(-1)?.body).toMatch(/^Closed by system:cancel/);
    // A closed approval does not make the cancelled run resumable.
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
    expect(h.provider.execCalls.length).toBe(execs);
    expect(ctx.runs.mustGet(run.id).status).toBe("cancelled");
  });

  it("cancels a queued run before it starts, without ever starting a sidecar", async () => {
    const { bot } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    scheduler.stop();
    const create = () =>
      ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: "cancel-queued",
        triggerPayload: { body: "x" },
        config: ctx.runConfig(),
      });
    const queued = create();
    const res = await h.api<{ run: RunRecord }>("POST", `/api/runs/${queued.id}/cancel`);
    expect(res.status).toBe(200);
    expect(ctx.runs.mustGet(queued.id as RunId).status).toBe("cancelled");
    expect(ctx.runs.mustGet(queued.id as RunId).startedAt).toBeUndefined();
    expect(ctx.runs.listQueued()).toEqual([]);
    expect(h.provider.execCalls).toHaveLength(0);
  });
});
