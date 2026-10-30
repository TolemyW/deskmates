// T1: the scheduler side of cancelling a run (issue #15). Cancelling frees the bot's lane at once,
// so the next queued run on it launches without waiting for the old process to exit; a process
// that stops by itself inside the grace window is never killed, one that does not is.

import type { BotDefinition, RunId, Thread } from "@deskmates/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
let releases: Array<() => void>;

beforeEach(async () => {
  h = await startHarness();
  releases = [];
});

afterEach(async () => {
  for (const release of releases) release();
  await h.close();
});

function hold(): Promise<void> {
  return new Promise<void>((resolve) => releases.push(resolve));
}

async function wake(thread: Thread, body: string): Promise<RunRecord> {
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body,
  });
  const run = m.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

/** A second run on the same bot and lane, in no thread so nothing coalesces it. */
function queueBehind(bot: BotDefinition): RunRecord {
  const { ctx } = h.app.deskmates;
  return ctx.runs.create({
    botId: bot.id,
    lane: "interactive",
    triggerKind: "webhook",
    triggerRef: "behind",
    triggerPayload: { body: "second" },
    config: ctx.runConfig(),
  });
}

it("frees the lane at once: the queued run behind a cancelled one launches before the old process exits", async () => {
  const { bot, thread } = await h.seed();
  const { ctx, scheduler } = h.app.deskmates;
  scheduler.cancelGraceMs = 60_000;
  const started: RunId[] = [];
  h.provider.onRun(async (req) => {
    started.push(req.runId);
    await hold();
  });
  const first = await wake(thread, "first");
  await waitFor(() => started.length === 1, 3000, "first started");
  const second = queueBehind(bot);
  scheduler.tick();
  expect(ctx.runs.mustGet(second.id).status).toBe("queued");
  expect(ctx.runs.laneBusy(bot.id, "interactive")).toBe(true);

  scheduler.cancel(first.id, "human:test");
  expect(ctx.runs.laneBusy(bot.id, "interactive")).toBe(false);
  await waitFor(() => started.includes(second.id), 3000, "second launched");
  expect(ctx.runs.mustGet(second.id).status).toBe("running");
  // The first process is still inside its grace window and has not been killed.
  expect(h.provider.execCalls[0]?.req.signal?.aborted).toBe(false);
});

it("does not kill a process that exits inside the grace window", async () => {
  const { thread } = await h.seed();
  const { ctx, scheduler } = h.app.deskmates;
  scheduler.cancelGraceMs = 50;
  let exitNow: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    exitNow = resolve;
  });
  let started = false;
  h.provider.onRun(async () => {
    started = true;
    await exited;
  });
  const run = await wake(thread, "work");
  await waitFor(() => started, 3000, "started");
  scheduler.cancel(run.id, "human:test");
  // The sidecar sees its token refused and exits on its own.
  exitNow();
  await scheduler.drain();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.provider.execCalls[0]?.req.signal?.aborted).toBe(false);
  expect(ctx.runs.mustGet(run.id).status).toBe("cancelled");
});

it("a run that fails closes its pending approvals, so no card stays answerable", async () => {
  const { thread } = await h.seed();
  const { ctx } = h.app.deskmates;
  h.provider.onRun(async (_req, gw) => {
    await gw.post("approvals", {
      type: "approval_request",
      approvalId: "apr-failed",
      action: { toolName: "Bash", input: { command: "git push" }, argumentSummary: "git push" },
      riskLevel: "L2",
      toolUseId: "toolu_failed",
    });
    // The sidecar dies without a run_ended.
    return { exitCode: 137 };
  });
  const run = await wake(thread, "push it");
  await waitFor(() => ctx.runs.mustGet(run.id).status === "failed", 3000, "failed");
  const approval = ctx.approvals.mustGet("apr-failed" as never);
  expect(approval.decision).toBe("deny");
  expect(approval.decidedBy).toBe("system:failed");
  const decide = await h.api("POST", "/api/approvals/apr-failed/decide", {
    decision: "allow_once",
  });
  expect(decide.status).toBeGreaterThanOrEqual(400);
});

it("refuses to cancel a terminal run and leaves it as it was", async () => {
  const { thread } = await h.seed();
  const { ctx, scheduler } = h.app.deskmates;
  h.provider.onRun(async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "failed",
      error: "boom",
      usage: [],
    });
  });
  const run = await wake(thread, "fail");
  await waitFor(() => ctx.runs.mustGet(run.id).status === "failed", 3000, "failed");
  expect(() => scheduler.cancel(run.id, "human:test")).toThrow(/already failed/);
  expect(ctx.runs.mustGet(run.id).status).toBe("failed");
});

it.each(["cancel", "timeout", "crash"])(
  "%s after measured turns preserves partial API and cost receipts without a final",
  async (mode) => {
    if (mode === "timeout") {
      await h.close();
      h = await startHarness({ runTimeoutSeconds: 1 });
    }
    const { thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    const exited = hold();
    let observed = false;
    h.provider.onRun(async (request) => {
      for (let turn = 1; turn <= 2; turn++)
        ctx.events.append({
          runId: request.runId,
          kind: "turn_usage",
          attempt: request.attempt,
          seq: turn,
          payload: {
            model: "measured",
            turn,
            inputTokens: 100 * turn,
            outputTokens: null,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        });
      observed = true;
      if (mode === "crash") throw new Error("synthetic process crash");
      await exited;
    });
    const run = await wake(thread, "observe then cancel");
    await waitFor(() => observed, 3000, "observations");
    if (mode === "cancel") scheduler.cancel(run.id, "human:test");
    else await waitFor(() => ctx.runs.mustGet(run.id).status === "failed", 3000, "failed");
    const detail = await h.api("GET", `/api/runs/${run.id}`);
    expect(detail.json).toMatchObject({
      run: { status: mode === "cancel" ? "cancelled" : "failed" },
      usageCoverage: "partial",
      usage: [{ inputTokens: 300, outputTokens: null, costUsd: null, coverage: "partial" }],
    });
    const costs = await h.api("GET", "/api/costs");
    expect(costs.json).toMatchObject({
      totals: { inputTokens: 300, usageCoverage: "partial", knownCostUsd: null },
    });
  },
);
