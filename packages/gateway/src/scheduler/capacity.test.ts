import type { BotDefinition, RunEnded } from "@deskmates/contracts";
import { expect, it } from "vitest";
import { startHarness, waitFor } from "../test-support/harness.js";

// ADR-0022 amendment 5: nothing caps how many sidecars run at once in a workspace or a tenant.
// The workspace container's CPU and memory limits bound them together; the scheduler only keeps
// each bot's lanes in order.

it("starts every free lane's run in one workspace while another run's process is still held", async () => {
  const h = await startHarness();
  const releases: Array<() => void> = [];
  try {
    const { workspace, bot } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    const others = await Promise.all(
      ["second", "third"].map(
        async (name) =>
          (
            await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
              name,
              workspaceId: workspace.id,
            })
          ).json.bot,
      ),
    );
    // Every run ends at once but keeps its process until released, the way a parked or exiting
    // sidecar holds on to its attempt.
    h.provider.onRun(async (req, gw) => {
      const ended: RunEnded = {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
      };
      await gw.post("ended", ended);
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    const run = (botId: typeof bot.id, lane: "interactive" | "background") =>
      ctx.runs.create({
        botId,
        lane,
        triggerKind: "webhook",
        triggerRef: "capacity",
        triggerPayload: { body: "test" },
        config: ctx.runConfig(),
      });
    const runs = [
      run(bot.id, "interactive"),
      run(bot.id, "background"),
      ...others.flatMap((b) => [run(b.id, "interactive"), run(b.id, "background")]),
    ];
    scheduler.tick();
    for (const r of runs) {
      await waitFor(() => ctx.runs.mustGet(r.id).status === "succeeded", 3000, `run ${r.id}`);
    }
    // A run is `succeeded` as soon as its `run_ended` lands, before its process starts waiting.
    await waitFor(() => releases.length === runs.length, 3000, "every process held");
    expect(scheduler.activeAttempts(workspace.id)).toBe(runs.length);
    expect(scheduler.capacity(workspace.id)).toEqual({
      activeAttempts: runs.length,
      waitingRunIds: [],
    });
    for (const r of runs) {
      expect(ctx.events.list(r.id).map((e) => e.payload)).not.toContainEqual(
        expect.objectContaining({ source: "scheduler" }),
      );
    }
    // Editing the workspace still waits for every process to exit.
    await expect(scheduler.withIdleWorkspace(workspace.id, async () => {})).rejects.toThrow(
      /finish/,
    );
    for (const release of releases.splice(0)) release();
    await scheduler.drain();
    expect(scheduler.activeAttempts(workspace.id)).toBe(0);
  } finally {
    for (const release of releases) release();
    await h.close();
  }
});

it("still runs one run per lane per bot: a second run on a busy lane waits for the first", async () => {
  const h = await startHarness();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const { bot } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    let starts = 0;
    h.provider.onRun(async (req, gw) => {
      starts += 1;
      if (starts === 1) await held;
      const ended: RunEnded = {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
      };
      await gw.post("ended", ended);
    });
    const run = () =>
      ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: "lane",
        triggerPayload: { body: "test" },
        config: ctx.runConfig(),
      });
    const first = run();
    scheduler.tick();
    await waitFor(() => ctx.runs.mustGet(first.id).status === "running", 3000, "first running");
    const second = run();
    scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.runs.mustGet(second.id).status).toBe("queued");
    release();
    await waitFor(() => ctx.runs.mustGet(second.id).status === "succeeded", 3000, "second ran");
    await scheduler.drain();
  } finally {
    release();
    await h.close();
  }
});
