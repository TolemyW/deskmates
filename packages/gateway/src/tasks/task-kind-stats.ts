// The kind view (ADR-0021 amendment 4, A4g): how one kind of work is getting done in a workspace,
// read at one Gateway instant. Every time is a Gateway timestamp from the task, run, checkpoint,
// delivery and transition rows. The view carries task records and numbers only: no message, no
// approval text, no run summary and no thread link, so a private chat reveals nothing here.

import {
  EXECUTING_RUN_STATUSES,
  type IsoTimestamp,
  type RunId,
  TASK_STALL_REASONS,
  TASK_STATUSES,
  type TaskKindDay,
  type TaskKindList,
  type TaskKindRow,
  type TaskKindStamp,
  type TaskKindStats,
  type TaskKindSummary,
  type TaskSlaState,
  type TaskStallReason,
  type TaskStatus,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { BotId } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { runSpend } from "../ledger/costs.js";
import { kindProgress, progressReports } from "./task-kind-progress.js";
import type { TaskTemplateStore } from "./task-templates.js";

/** Defaults and bounds of the view's query (A4g); the stall window and at-risk share are guesses. */
export const KIND_VIEW = {
  windowDays: 30,
  maxWindowDays: 90,
  stalledMinutes: 60,
  maxStalledMinutes: 30 * 24 * 60,
  drillDown: 200,
  /** An open task past this share of its target is at risk. */
  atRiskShare: 0.8,
} as const;

const OPEN: readonly TaskStatus[] = ["planned", "in_progress", "blocked"];
const ACTIVE = new Set<string>(["queued", ...EXECUTING_RUN_STATUSES]);

interface KindTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  owner_bot_id: string | null;
  created_at: string;
  delivered_at: string | null;
  sla_minutes: number | null;
  kind_json: string;
}

interface RunAgg {
  task_id: string;
  runs: number;
  last_run_at: string | null;
}

interface RunState {
  task_id: string;
  run_id: string;
  status: string;
  pending: number;
}

interface TransitionRow {
  task_id: string;
  field: "status" | "owner";
  from_value: string | null;
  to_value: string | null;
  created_at: string;
}

const minutesBetween = (from: string, to: Date) =>
  Math.max(0, Math.round((to.getTime() - new Date(from).getTime()) / 60_000));

/** Nearest-rank percentile of sorted values; null for none. */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

export class TaskKindView {
  constructor(
    private readonly db: GatewayDb,
    private readonly templates: TaskTemplateStore,
  ) {}

  /** The kinds of a workspace: its templates (built-ins included) and every stamped kind. */
  kinds(workspaceId: WorkspaceId): TaskKindList {
    const counts = new Map(
      (
        this.db
          .prepare(`SELECT kind, count(*) AS total,
              sum(CASE WHEN status IN ('planned', 'in_progress', 'blocked') THEN 1 ELSE 0 END) AS open
            FROM tasks WHERE workspace_id = ? AND kind IS NOT NULL AND deleted_at IS NULL
            GROUP BY kind`)
          .all(workspaceId) as { kind: string; total: number; open: number }[]
      ).map((row) => [row.kind, row]),
    );
    const seen = new Set<string>();
    const kinds: TaskKindSummary[] = this.templates
      .list(workspaceId, { archived: true })
      .flatMap((t) => {
        const count = counts.get(t.kind);
        // An archived template with no task is history only; it is not a kind of work any more.
        if (t.archivedAt !== null && !count) return [];
        seen.add(t.kind);
        return [
          {
            kind: t.kind,
            name: t.name,
            templateId: t.id,
            builtIn: t.builtIn,
            total: count?.total ?? 0,
            open: count?.open ?? 0,
          },
        ];
      });
    for (const [kind, count] of counts)
      if (!seen.has(kind))
        kinds.push({
          kind,
          name: kind,
          templateId: null,
          builtIn: false,
          total: count.total,
          open: count.open,
        });
    return { kinds };
  }

  stats(
    workspaceId: WorkspaceId,
    kind: string,
    now: Date,
    opts: { windowDays?: number; stalledMinutes?: number } = {},
  ): TaskKindStats {
    const windowDays = opts.windowDays ?? KIND_VIEW.windowDays;
    const stalledMinutes = opts.stalledMinutes ?? KIND_VIEW.stalledMinutes;
    const rows = this.db
      .prepare(`SELECT id, title, status, owner_bot_id, created_at, delivered_at, sla_minutes,
          kind_json FROM tasks WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, rowid DESC`)
      .all(workspaceId, kind) as KindTaskRow[];
    const template = this.templates.forKind(workspaceId, kind);
    const firstStamp = rows[0]
      ? (JSON.parse(rows[0].kind_json) as Omit<TaskKindStamp, "fields">)
      : undefined;

    const scope = "SELECT id FROM tasks WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL";
    const runAggs = new Map(
      (
        this.db
          .prepare(`SELECT tr.task_id, count(*) AS runs,
              max(coalesce(r.finished_at, r.started_at, r.created_at)) AS last_run_at
            FROM task_runs tr JOIN runs r ON r.id = tr.run_id
            WHERE tr.task_id IN (${scope}) GROUP BY tr.task_id`)
          .all(workspaceId, kind) as RunAgg[]
      ).map((row) => [row.task_id, row]),
    );
    const runStates = this.db
      .prepare(`SELECT tr.task_id, r.id AS run_id, r.status,
          (SELECT count(*) FROM approvals a WHERE a.run_id = r.id AND a.decision IS NULL) AS pending
        FROM task_runs tr JOIN runs r ON r.id = tr.run_id WHERE tr.task_id IN (${scope})`)
      .all(workspaceId, kind) as RunState[];
    const runsOf = new Map<string, RunState[]>();
    for (const run of runStates) runsOf.set(run.task_id, [...(runsOf.get(run.task_id) ?? []), run]);
    const lastOf = (table: "task_checkpoints" | "task_deliveries") =>
      new Map(
        (
          this.db
            .prepare(`SELECT task_id, max(created_at) AS at FROM ${table}
              WHERE task_id IN (${scope}) GROUP BY task_id`)
            .all(workspaceId, kind) as { task_id: string; at: string }[]
        ).map((row) => [row.task_id, row.at]),
      );
    const lastCheckpoint = lastOf("task_checkpoints");
    const lastDelivery = lastOf("task_deliveries");
    const transitions = this.db
      .prepare(`SELECT task_id, field, from_value, to_value, created_at FROM task_transitions
        WHERE workspace_id = ? AND task_id IN (${scope}) ORDER BY seq`)
      .all(workspaceId, workspaceId, kind) as TransitionRow[];
    const escalationsOf = new Map<string, number>();
    const reassignmentsOf = new Map<string, number>();
    for (const t of transitions) {
      if (t.field === "status" && t.to_value === "blocked")
        escalationsOf.set(t.task_id, (escalationsOf.get(t.task_id) ?? 0) + 1);
      if (t.field === "owner" && t.from_value !== null && t.from_value !== t.to_value)
        reassignmentsOf.set(t.task_id, (reassignmentsOf.get(t.task_id) ?? 0) + 1);
    }

    const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<
      TaskStatus,
      number
    >;
    const stalled = Object.fromEntries(TASK_STALL_REASONS.map((r) => [r, 0])) as Record<
      TaskStallReason,
      number
    >;
    const durations: number[] = [];
    let withinSla = 0;
    let breachedSla = 0;
    let overdue = 0;
    let atRisk = 0;
    const tableRows: TaskKindRow[] = [];
    for (const [index, row] of rows.entries()) {
      counts[row.status] += 1;
      const open = OPEN.includes(row.status);
      const done = row.status === "delivered" || row.status === "accepted";
      const timeToDone =
        done && row.delivered_at !== null
          ? minutesBetween(row.created_at, new Date(row.delivered_at))
          : null;
      if (timeToDone !== null) durations.push(timeToDone);
      const age = minutesBetween(row.created_at, now);
      let sla: TaskSlaState = "none";
      if (row.sla_minutes !== null) {
        if (timeToDone !== null) sla = timeToDone <= row.sla_minutes ? "within" : "breached";
        else if (open)
          sla =
            age > row.sla_minutes
              ? "overdue"
              : age > row.sla_minutes * KIND_VIEW.atRiskShare
                ? "at_risk"
                : "on_track";
      }
      if (sla === "within") withinSla += 1;
      if (sla === "breached") breachedSla += 1;
      if (sla === "overdue") overdue += 1;
      if (sla === "at_risk") atRisk += 1;

      const runs = runsOf.get(row.id) ?? [];
      const lastActivity = [
        runAggs.get(row.id)?.last_run_at ?? null,
        lastCheckpoint.get(row.id) ?? null,
        lastDelivery.get(row.id) ?? null,
      ]
        .filter((at): at is string => at !== null)
        .sort()
        .at(-1);
      let stall: TaskStallReason | null = null;
      if (open) {
        if (
          runs.some(
            (r) =>
              r.pending > 0 ||
              r.status === "waiting_approval" ||
              r.status === "waiting_approval_live",
          )
        )
          stall = "waiting_approval";
        else if (row.status === "blocked") stall = "waiting_human";
        else if (
          !runs.some((r) => ACTIVE.has(r.status)) &&
          minutesBetween(lastActivity ?? row.created_at, now) > stalledMinutes
        )
          stall = "no_activity";
      } else if (row.status === "delivered" && row.delivered_at !== null) {
        if (minutesBetween(row.delivered_at, now) > stalledMinutes) stall = "awaiting_acceptance";
      }
      if (stall) stalled[stall] += 1;
      if (index >= KIND_VIEW.drillDown) continue;
      const stamp = JSON.parse(row.kind_json) as Omit<TaskKindStamp, "fields">;
      tableRows.push({
        id: row.id,
        title: row.title,
        status: row.status,
        ownerBotId: row.owner_bot_id as BotId | null,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
        ageMinutes: age,
        timeToDoneMinutes: timeToDone,
        sla,
        stall,
        lastActivityAt: (lastActivity ?? null) as IsoTimestamp | null,
        currentStage: kindProgress(stamp, row.status, progressReports(this.db, row.id))
          .currentStage,
        escalations: escalationsOf.get(row.id) ?? 0,
        reassignments: reassignmentsOf.get(row.id) ?? 0,
        runCount: runAggs.get(row.id)?.runs ?? 0,
        costUsd: null,
        fields: this.fields(row.id),
      });
    }

    // Cost of the drill-down's tasks from their linked runs (ADR-0032): known plus estimated.
    let knownUsd = 0;
    let estimatedUsd = 0;
    let unpricedRuns = 0;
    let pricedTasks = 0;
    for (const row of tableRows) {
      let taskUsd: number | null = null;
      for (const run of runsOf.get(row.id) ?? []) {
        const spend = runSpend(this.db, run.run_id as RunId);
        if (!spend) continue;
        if (spend.unmeasuredUsageCount + spend.unestimatedUsageCount > 0) unpricedRuns += 1;
        knownUsd += spend.knownUsd;
        estimatedUsd += spend.estimatedUsd;
        if (spend.knownUsd > 0 || spend.estimatedUsd > 0)
          taskUsd = (taskUsd ?? 0) + spend.knownUsd + spend.estimatedUsd;
      }
      if (taskUsd !== null) {
        row.costUsd = micro(taskUsd);
        pricedTasks += 1;
      }
    }

    durations.sort((a, b) => a - b);
    const considered = rows.length - counts.cancelled;
    const doneCount = counts.delivered + counts.accepted;
    return {
      kind,
      name: template?.name ?? firstStamp?.name ?? kind,
      observedAt: now.toISOString() as IsoTimestamp,
      windowDays,
      stalledMinutes,
      slaMinutes: template?.slaMinutes ?? firstStamp?.slaMinutes ?? null,
      counts,
      total: rows.length,
      series: series(rows, transitions, now, windowDays),
      completion: {
        done: doneCount,
        considered,
        rate: considered > 0 ? doneCount / considered : null,
        acceptedRate: considered > 0 ? counts.accepted / considered : null,
      },
      timeToDone: {
        count: durations.length,
        p50Minutes: nearestRank(durations, 0.5),
        p90Minutes: nearestRank(durations, 0.9),
        withinSla,
        breachedSla,
      },
      overdue,
      atRisk,
      stalled,
      escalations: [...escalationsOf.values()].reduce((a, b) => a + b, 0),
      reassignments: [...reassignmentsOf.values()].reduce((a, b) => a + b, 0),
      cost: {
        knownUsd: micro(knownUsd),
        estimatedUsd: micro(estimatedUsd),
        perTaskUsd: pricedTasks > 0 ? micro((knownUsd + estimatedUsd) / pricedTasks) : null,
        unpricedRuns,
        coveredTasks: tableRows.length,
      },
      tasks: tableRows,
      truncated: rows.length > tableRows.length,
    };
  }

  private fields(taskId: string): Record<string, string> {
    return Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT field_key, value FROM task_field_values WHERE task_id = ? ORDER BY field_key",
          )
          .all(taskId) as { field_key: string; value: string }[]
      ).map((f) => [f.field_key, f.value]),
    );
  }
}

/** Daily flows over the window, oldest day first, in UTC. */
function series(
  rows: readonly KindTaskRow[],
  transitions: readonly TransitionRow[],
  now: Date,
  windowDays: number,
): TaskKindDay[] {
  const days: TaskKindDay[] = [];
  const index = new Map<string, TaskKindDay>();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const day = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
    const entry = { day, created: 0, delivered: 0, accepted: 0, cancelled: 0, escalated: 0 };
    days.push(entry);
    index.set(day, entry);
  }
  for (const row of rows) {
    const entry = index.get(row.created_at.slice(0, 10));
    if (entry) entry.created += 1;
  }
  for (const t of transitions) {
    if (t.field !== "status") continue;
    const entry = index.get(t.created_at.slice(0, 10));
    if (!entry) continue;
    if (t.to_value === "delivered") entry.delivered += 1;
    if (t.to_value === "accepted") entry.accepted += 1;
    if (t.to_value === "cancelled") entry.cancelled += 1;
    if (t.to_value === "blocked") entry.escalated += 1;
  }
  return days;
}
