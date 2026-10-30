// T1: the recorded policy and learned-write receipt identify the same applied strategy.
import { expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { startHarness, waitFor } from "../test-support/harness.js";

it("records the applied memory policy on the run and its learned-write receipt", async () => {
  const h = await startHarness();
  try {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "Observed quota",
          reply: "Submitted for storage",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          learned: [
            {
              body: "Current quota is 280, replacing 300.",
              proposedScope: "workspace",
              authority: "fact",
              trust: "trusted",
              sourceKind: "bot_self",
              turn: 1,
            },
          ],
        },
        usage: [],
      });
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      {
        body: "Remember the current quota",
      },
    );
    const run = posted.json.runs[0];
    expect(run).toBeDefined();
    if (!run) throw new Error("missing run");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "memory write",
    );
    const stored = h.app.deskmates.ctx.runs.mustGet(run.id);
    expect(stored.config.memoryValuePolicy).toBe("multi-number-body-v1");
    const receipt = h.app.deskmates.ctx.events
      .list(run.id)
      .find((e) => e.payload.source === "learned_memory");
    expect(receipt?.payload).toMatchObject({
      valuePolicy: stored.config.memoryValuePolicy,
      outcomes: [{ ordinal: 0, outcome: "applied" }],
    });
  } finally {
    await h.close();
  }
});
