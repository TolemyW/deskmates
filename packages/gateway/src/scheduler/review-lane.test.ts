// T1, ADR-0002 amendment 4 B5: an approval review does not queue behind the lane of the bot it
// reviews (that lane is held by the run waiting for the verdict), and at most two reviews run at
// once in one workspace.

import type { StartRunRequest } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_REVIEW, REVIEWS_PER_WORKSPACE } from "../approvals/auto-review.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe("review runs and lanes (B5)", () => {
  it("start while the bot's background lane is held, bounded per workspace", async () => {
    const { bot } = await h.seed();
    const { ctx } = h.app.deskmates;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      started.push(req);
      await hold;
      await gw.post("ended", { type: "run_ended", runId: req.runId, outcome: "failed", usage: [] });
    });
    // The actor holds the background lane, as a cron run waiting on its approval does.
    const actor = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "cron:test",
      triggerPayload: { prompt: "nightly" },
    });
    h.app.deskmates.scheduler.kick();
    await waitFor(() => started.some((r) => r.runId === actor.id), 2000, "actor started");
    const reviews = [1, 2, 3].map((n) =>
      ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "model_job",
        triggerRef: `${APPROVAL_REVIEW}:apr-${n}`,
        triggerPayload: { prompt: '{"action":{}}' },
        config: { runType: APPROVAL_REVIEW, approvalId: `apr-${n}`, maxTurns: 1 },
      }),
    );
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => started.filter((r) => r.modelJob?.kind === "approval_review").length === 2,
      2000,
      "two reviews started",
    );
    expect(REVIEWS_PER_WORKSPACE).toBe(2);
    expect(reviews.map((r) => ctx.runs.mustGet(r.id).status).sort()).toEqual([
      "queued",
      "running",
      "running",
    ]);
    release();
    await waitFor(
      () => started.filter((r) => r.modelJob?.kind === "approval_review").length === 3,
      2000,
      "third review started after a slot freed",
    );
  });
});
