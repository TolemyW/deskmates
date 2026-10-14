// T1 (ADR-0021 amendment 3, A3d): per-task schedules. One-time and repeating occurrences fire
// once, a duplicated tick or restart writes nothing, a late occurrence is missed, a live run makes
// the occurrence a skip, and an edit invalidates the old occurrence.
import type { WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { TaskDispatcher } from "./task-dispatch.js";
import { latestDueOccurrence, nextOccurrence } from "./task-schedule.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  await app.ready();
  app.deskmates.scheduler.stop();
});
afterEach(async () => {
  await app.close();
});

function seed(schedule: Parameters<FastifyInstance["deskmates"]["ctx"]["tasks"]["create"]>[2]) {
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name: "sched", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: workspace.id, name: "sched", role: "writer" });
  const task = ctx.tasks.create(workspace.id, { title: "Report", ownerBotId: bot.id }, schedule);
  const dispatcher = new TaskDispatcher(ctx, () => {});
  return { ctx, workspace, task, dispatcher };
}

const rows = () =>
  app.deskmates.ctx.db
    .prepare("SELECT kind, dispatch, occurrence_at, submission_key FROM task_submissions")
    .all() as Array<{
    kind: string;
    dispatch: string;
    occurrence_at: string;
    submission_key: string;
  }>;

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms);

describe("task schedules (A3d)", () => {
  it("computes the next occurrence in the schedule's time zone", () => {
    const after = new Date("2026-10-13T00:00:00.000Z");
    const row = { kind: "repeat" as const, run_at: null, cron: "0 9 * * *" };
    expect(nextOccurrence({ ...row, time_zone: "Asia/Shanghai" }, after)).toBe(
      "2026-10-13T01:00:00.000Z",
    );
    expect(nextOccurrence({ ...row, time_zone: "UTC" }, after)).toBe("2026-10-13T09:00:00.000Z");
    expect(
      nextOccurrence(
        { kind: "once", run_at: "2026-10-12T00:00:00.000Z", cron: null, time_zone: "UTC" },
        after,
      ),
    ).toBeNull();
  });

  it("acts on the latest due occurrence only, never replaying the ones in between", () => {
    const row = {
      task_id: "t",
      workspace_id: "w",
      kind: "repeat" as const,
      run_at: null,
      cron: "*/5 * * * *",
      time_zone: "UTC",
      is_enabled: 1,
      version: 1,
      next_fire_at: "2026-10-13T10:00:00.000Z",
      last_fired_at: null,
    };
    expect(latestDueOccurrence(row, new Date("2026-10-13T10:17:00.000Z"))).toBe(
      "2026-10-13T10:15:00.000Z",
    );
    expect(latestDueOccurrence(row, new Date("2026-10-13T09:59:00.000Z"))).toBeNull();
  });

  it("fires a one-time schedule once, then disables it; saving ran nothing", () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const { ctx, workspace, task, dispatcher } = seed({ schedule: { kind: "once", runAt } });
    expect(rows()).toEqual([]);
    dispatcher.tick(plus(runAt, -60_000));
    expect(rows()).toEqual([]);
    dispatcher.tick(plus(runAt, 30_000));
    dispatcher.tick(plus(runAt, 30_000)); // a duplicated tick
    dispatcher.tick(plus(runAt, 90_000)); // the next minute: the schedule is disabled
    expect(rows()).toEqual([
      {
        kind: "scheduled",
        dispatch: "posted",
        occurrence_at: runAt,
        submission_key: `schedule:1:${runAt}`,
      },
    ]);
    expect(ctx.runs.list({}).length).toBe(1);
    expect(ctx.tasks.mustGet(workspace.id as WorkspaceId, task.id).schedule).toBeNull();
  });

  it("records a late occurrence as missed and starts nothing", () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const { ctx, dispatcher } = seed({ schedule: { kind: "once", runAt } });
    dispatcher.tick(plus(runAt, 20 * 60_000));
    expect(rows().map((r) => r.dispatch)).toEqual(["missed"]);
    expect(ctx.runs.list({})).toEqual([]);
  });

  it("skips a repeating occurrence while the previous run is live", () => {
    const { ctx, workspace, task, dispatcher } = seed({
      schedule: { kind: "repeat", cron: "*/5 * * * *" },
    });
    const first = ctx.tasks.mustGet(workspace.id as WorkspaceId, task.id).schedule?.nextFireAt;
    if (!first) throw new Error("no occurrence");
    dispatcher.tick(plus(first, 10_000));
    dispatcher.tick(plus(first, 5 * 60_000 + 10_000));
    expect(rows().map((r) => r.dispatch)).toEqual(["posted", "skipped_overlap"]);
    expect(ctx.runs.list({}).length).toBe(1);
    // Once the run is over, the next occurrence posts again.
    const run = ctx.runs.list({})[0];
    if (!run) throw new Error("no run");
    ctx.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(run.id);
    dispatcher.tick(plus(first, 10 * 60_000 + 10_000));
    expect(rows().map((r) => r.dispatch)).toEqual(["posted", "skipped_overlap", "posted"]);
  });

  it("invalidates the old occurrence when the schedule is edited, and skips deleted tasks", () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const { ctx, workspace, task, dispatcher } = seed({ schedule: { kind: "once", runAt } });
    const stale = ctx.tasks.schedules.row(task.id);
    if (!stale) throw new Error("no schedule");
    const later = new Date(Date.now() + 7_200_000).toISOString();
    ctx.tasks.update(workspace.id as WorkspaceId, task.id, {
      version: task.version,
      schedule: { kind: "once", runAt: later },
    });
    // A tick that read the old row loses the compare-and-set and writes nothing.
    expect(ctx.tasks.schedules.advance(stale, plus(runAt, 10_000), runAt)).toBe(false);
    dispatcher.tick(plus(runAt, 10_000));
    expect(rows()).toEqual([]);
    const current = ctx.tasks.mustGet(workspace.id as WorkspaceId, task.id);
    expect(current.schedule).toMatchObject({ version: 2, nextFireAt: later });
    ctx.tasks.softDelete(workspace.id as WorkspaceId, task.id, { version: current.version }, "x");
    dispatcher.tick(plus(later, 10_000));
    expect(rows()).toEqual([]);
  });
});
