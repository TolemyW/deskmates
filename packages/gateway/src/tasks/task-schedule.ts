// Per-task schedules (ADR-0021 amendment 3, decision A3d). One row per task, `once` at a UTC
// instant or `repeat` with a five-field cron expression read in a named IANA zone. The Gateway
// computes `next_fire_at`; the runner below acts on the latest due occurrence of each schedule:
//
//   - a missed tick is not replayed: an occurrence more than MISSED_AFTER_MS late is recorded
//     once as `missed` and the schedule advances;
//   - overlap is a skip: while a run of an earlier submission is live, the occurrence is recorded
//     as `skipped_overlap` and starts nothing (as the bot cron runner does);
//   - a `once` schedule is disabled after its occurrence; a `repeat` one advances past now;
//   - every edit bumps the schedule version, and firing compares and sets (version, next_fire_at)
//     in the transaction that inserts the keyed submission, so an edited or replayed occurrence
//     never fires twice.
//
// The bot cron runner (`triggers/cron.ts`) is untouched; its entries are not task schedules.

import {
  DeskmatesError,
  type IsoTimestamp,
  type TaskSchedule,
  type TaskScheduleInput,
  type WorkspaceId,
  nextCronFire,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

/** An occurrence later than this is `missed`, not fired. A guess, recorded in the ADR. */
export const MISSED_AFTER_MS = 10 * 60_000;
/** Same cadence as the bot cron runner. */
export const TASK_SCHEDULE_TICK_MS = 60_000;

export interface ScheduleRow {
  task_id: string;
  workspace_id: string;
  kind: "once" | "repeat";
  run_at: string | null;
  cron: string | null;
  time_zone: string;
  is_enabled: number;
  version: number;
  next_fire_at: string | null;
  last_fired_at: string | null;
}

export function toSchedule(row: ScheduleRow): TaskSchedule {
  return {
    kind: row.kind,
    runAt: row.run_at as IsoTimestamp | null,
    cron: row.cron,
    timeZone: row.time_zone,
    enabled: row.is_enabled === 1,
    version: row.version,
    nextFireAt: row.next_fire_at as IsoTimestamp | null,
    lastFiredAt: row.last_fired_at as IsoTimestamp | null,
  };
}

/** The first occurrence strictly after `after`, or null when there is none. */
export function nextOccurrence(
  schedule: Pick<ScheduleRow, "kind" | "run_at" | "cron" | "time_zone">,
  after: Date,
): string | null {
  if (schedule.kind === "once")
    return schedule.run_at !== null && new Date(schedule.run_at) > after ? schedule.run_at : null;
  if (schedule.cron === null) return null;
  return nextCronFire(schedule.cron, after, schedule.time_zone)?.toISOString() ?? null;
}

/**
 * The latest occurrence at or before `now`, starting from the stored `next_fire_at`. For a repeat
 * schedule several occurrences may have passed while the Gateway was down; only the last counts.
 */
export function latestDueOccurrence(row: ScheduleRow, now: Date): string | null {
  if (row.next_fire_at === null || new Date(row.next_fire_at) > now) return null;
  if (row.kind === "once" || row.cron === null) return row.next_fire_at;
  let latest = row.next_fire_at;
  // Bounded walk: a week of minutes at most, then the stored value stands.
  for (let i = 0; i < 7 * 24 * 60; i += 1) {
    const next = nextCronFire(row.cron, new Date(latest), row.time_zone);
    if (!next || next > now) break;
    latest = next.toISOString();
  }
  return latest;
}

export class TaskSchedules {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date,
    /** The Gateway's `CRON_TIME_ZONE`; UTC when unset. */
    private readonly defaultTimeZone: string = "UTC",
  ) {}

  row(taskId: string): ScheduleRow | undefined {
    return this.db.prepare("SELECT * FROM task_schedules WHERE task_id = ?").get(taskId) as
      | ScheduleRow
      | undefined;
  }

  /** The schedule the task view shows; a removed (disabled) schedule reads as none. */
  get(taskId: string): TaskSchedule | null {
    const row = this.row(taskId);
    return row && row.is_enabled === 1 ? toSchedule(row) : null;
  }

  /**
   * Replace (or, with null, disable) a task's schedule; always bumps the version so an occurrence
   * of the previous schedule cannot fire after this commits. Call inside the caller's transaction.
   */
  set(workspaceId: WorkspaceId, taskId: string, input: TaskScheduleInput | null): void {
    const now = this.clock();
    const at = now.toISOString();
    const current = this.row(taskId);
    if (input === null) {
      if (current)
        this.db
          .prepare(`UPDATE task_schedules SET is_enabled = 0, next_fire_at = NULL,
            version = version + 1, updated_at = ? WHERE task_id = ?`)
          .run(at, taskId);
      return;
    }
    const next = {
      kind: input.kind,
      run_at: input.kind === "once" ? input.runAt : null,
      cron: input.kind === "repeat" ? input.cron : null,
      time_zone: input.timeZone ?? this.defaultTimeZone,
    };
    if (input.kind === "once" && new Date(input.runAt) <= now)
      throw new DeskmatesError("validation", "runAt must be in the future", { key: "runAt" });
    const nextFireAt = nextOccurrence(next, now);
    if (nextFireAt === null)
      throw new DeskmatesError("validation", "the schedule has no future occurrence", {
        key: "schedule",
      });
    if (current)
      this.db
        .prepare(`UPDATE task_schedules SET kind = @kind, run_at = @run_at, cron = @cron,
          time_zone = @time_zone, is_enabled = 1, version = version + 1,
          next_fire_at = @next_fire_at, updated_at = @at WHERE task_id = @task_id`)
        .run({ ...next, next_fire_at: nextFireAt, at, task_id: taskId });
    else
      this.db
        .prepare(`INSERT INTO task_schedules (task_id, workspace_id, kind, run_at, cron, time_zone,
          is_enabled, version, next_fire_at, created_at, updated_at)
          VALUES (@task_id, @workspace_id, @kind, @run_at, @cron, @time_zone, 1, 1,
          @next_fire_at, @at, @at)`)
        .run({ ...next, next_fire_at: nextFireAt, at, task_id: taskId, workspace_id: workspaceId });
  }

  /** Enabled schedules whose next occurrence is due, on tasks that are not deleted. */
  due(now: Date): ScheduleRow[] {
    return this.db
      .prepare(`SELECT s.* FROM task_schedules s JOIN tasks t ON t.id = s.task_id
        WHERE s.is_enabled = 1 AND s.next_fire_at <= ? AND t.deleted_at IS NULL
        ORDER BY s.next_fire_at, s.task_id`)
      .all(now.toISOString()) as ScheduleRow[];
  }

  /**
   * Advance a schedule past `now` if it is still the one that was read (compare and set). Returns
   * false when an edit or another tick got there first: then the caller must write nothing.
   */
  advance(row: ScheduleRow, now: Date, firedAt: string | null): boolean {
    const next = row.kind === "once" ? null : nextOccurrence(row, now);
    const result = this.db
      .prepare(`UPDATE task_schedules SET next_fire_at = ?, is_enabled = ?,
        last_fired_at = COALESCE(?, last_fired_at), updated_at = ?
        WHERE task_id = ? AND version = ? AND is_enabled = 1 AND next_fire_at IS ?`)
      .run(
        next,
        next === null ? 0 : 1,
        firedAt,
        now.toISOString(),
        row.task_id,
        row.version,
        row.next_fire_at,
      );
    return result.changes === 1;
  }
}
