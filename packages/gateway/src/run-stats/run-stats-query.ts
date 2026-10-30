// The `run_stats` answer (ADR-0050 decisions 3 to 5): the calling run's bot in the calling run's
// workspace, computed from the ledger with no model call. Every query below filters on both the
// workspace and the bot, which the caller reads from the run row, never from the request
// (decision 2). Only counts, enums, ids, timestamps and durations leave this module, plus the
// titles of the bot's own open tasks, which the sidecar wraps as untrusted (decision 4): no error
// text, summary, message body or approval summary is selected at all.

import {
  type ApprovalId,
  type BotId,
  EXECUTING_RUN_STATUSES,
  PARKED_RUN_STATUSES,
  RUN_STATS_LIST_MAX,
  type RunFailureClass,
  type RunId,
  type RunLane,
  type RunStatsApproval,
  type RunStatsDurations,
  type RunStatsParkedRun,
  type RunStatsReport,
  type RunStatsSpend,
  type RunStatsTask,
  type RunStatsWindow,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
  type TaskStatus,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { CostQueryStore } from "../ledger/costs.js";
import { failureClassSql } from "../ledger/failure-class.js";

const DAY_MS = 86_400_000;
const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["planned", "in_progress", "blocked"];

export interface RunStatsScope {
  runId: RunId;
  botId: BotId;
  workspaceId: WorkspaceId;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sqlList = (values: Iterable<string>) =>
  [...values].map((v) => `'${v.replaceAll("'", "''")}'`).join(", ");
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The value at fraction `q` of an ascending list (nearest rank); null when empty. */
function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return round(sorted[index] as number);
}

interface GroupRow {
  status: RunStatus;
  lane: RunLane;
  job: number;
  private_chat: number;
  failure_class: RunFailureClass | null;
  n: number;
}

class RunStatsQuery {
  constructor(
    private readonly db: GatewayDb,
    private readonly scope: RunStatsScope,
  ) {}

  /** `created_at` in [from 00:00, to + 1 day 00:00): whole UTC days, index-friendly. */
  private bounds(from: string, to: string): [string, string] {
    return [
      `${from}T00:00:00.000Z`,
      `${day(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS)}T00:00:00.000Z`,
    ];
  }

  window(from: string, to: string, tenantId: string): RunStatsWindow {
    const { botId, workspaceId } = this.scope;
    const [start, end] = this.bounds(from, to);
    const groups = this.db
      .prepare(
        `SELECT r.status, r.lane, (r.run_type IS NOT NULL) AS job,
                (t.private_to_user_id IS NOT NULL) AS private_chat,
                CASE WHEN r.status = 'failed'
                  THEN coalesce(${failureClassSql("r.error")}, 'other') END AS failure_class,
                count(*) AS n
           FROM runs r LEFT JOIN threads t ON t.id = r.thread_id
          WHERE r.workspace_id = ? AND r.bot_id = ? AND r.created_at >= ? AND r.created_at < ?
          GROUP BY 1, 2, 3, 4, 5`,
      )
      .all(workspaceId, botId, start, end) as GroupRow[];
    const byStatus: RunStatsWindow["byStatus"] = {};
    const byLane: RunStatsWindow["byLane"] = { interactive: 0, background: 0 };
    const failureClasses: RunStatsWindow["failureClasses"] = {};
    let runs = 0;
    let jobRuns = 0;
    let privateChatRuns = 0;
    for (const g of groups) {
      runs += g.n;
      byStatus[g.status] = (byStatus[g.status] ?? 0) + g.n;
      byLane[g.lane] += g.n;
      if (g.job) jobRuns += g.n;
      if (g.private_chat) privateChatRuns += g.n;
      if (g.failure_class)
        failureClasses[g.failure_class] = (failureClasses[g.failure_class] ?? 0) + g.n;
    }
    return {
      from,
      to,
      runs,
      byStatus,
      byLane,
      failureClasses,
      jobRuns,
      privateChatRuns,
      durations: this.durations(start, end),
      spend: this.spend(tenantId, from, to),
    };
  }

  private durations(start: string, end: string): RunStatsDurations {
    const { botId, workspaceId } = this.scope;
    const seconds = (
      this.db
        .prepare(
          `SELECT max(0, (julianday(finished_at) - julianday(coalesce(started_at, created_at)))
                    * 86400.0) AS s
             FROM runs
            WHERE workspace_id = ? AND bot_id = ? AND created_at >= ? AND created_at < ?
              AND finished_at IS NOT NULL
            ORDER BY s`,
        )
        .all(workspaceId, botId, start, end) as { s: number }[]
    ).map((row) => row.s);
    const total = seconds.reduce((sum, s) => sum + s, 0);
    return {
      finished: seconds.length,
      medianSeconds: quantile(seconds, 0.5),
      p90Seconds: quantile(seconds, 0.9),
      maxSeconds: seconds.length ? round(seconds[seconds.length - 1] as number) : null,
      totalSeconds: round(total),
    };
  }

  /** The Costs computation itself (ADR-0032), so the bot sees what an operator would. */
  private spend(tenantId: string, from: string, to: string): RunStatsSpend {
    const { totals } = new CostQueryStore(this.db).summary(tenantId, {
      workspaceId: this.scope.workspaceId,
      botId: this.scope.botId,
      from,
      to,
    });
    return {
      knownCostUsd: totals.knownCostUsd,
      estimatedCostUsd: totals.estimatedCostUsd ?? null,
      costStatus: totals.costStatus,
      pricedUsageCount: totals.pricedUsageCount,
      unpricedUsageCount: totals.unpricedUsageCount,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreateTokens: totals.cacheCreateTokens,
    };
  }

  private count(sql: string, ...params: unknown[]): number {
    return (this.db.prepare(sql).get(...params) as { n: number }).n;
  }

  pendingApprovals(): RunStatsReport["now"]["pendingApprovals"] {
    const { botId, workspaceId } = this.scope;
    const where = "workspace_id = ? AND bot_id = ? AND decision IS NULL";
    const items = (
      this.db
        .prepare(
          `SELECT id, run_id, kind, json_extract(action_json, '$.toolName') AS tool, created_at
             FROM approvals WHERE ${where} ORDER BY created_at, id LIMIT ?`,
        )
        .all(workspaceId, botId, RUN_STATS_LIST_MAX) as {
        id: string;
        run_id: string;
        kind: RunStatsApproval["kind"];
        tool: unknown;
        created_at: string;
      }[]
    ).map(
      (row): RunStatsApproval => ({
        approvalId: row.id as ApprovalId,
        runId: row.run_id as RunId,
        kind: row.kind,
        toolName: typeof row.tool === "string" ? row.tool : null,
        waitingSince: row.created_at,
      }),
    );
    return {
      total: this.count(`SELECT count(*) AS n FROM approvals WHERE ${where}`, workspaceId, botId),
      items,
    };
  }

  parkedRuns(): RunStatsReport["now"]["parkedRuns"] {
    const { botId, workspaceId } = this.scope;
    const where = `workspace_id = ? AND bot_id = ? AND status IN (${sqlList(PARKED_RUN_STATUSES)})`;
    const byStatus: Partial<Record<RunStatus, number>> = {};
    let total = 0;
    for (const row of this.db
      .prepare(`SELECT status, count(*) AS n FROM runs WHERE ${where} GROUP BY status`)
      .all(workspaceId, botId) as { status: RunStatus; n: number }[]) {
      byStatus[row.status] = row.n;
      total += row.n;
    }
    const items = (
      this.db
        .prepare(
          `SELECT id, status, lane, created_at FROM runs WHERE ${where}
            ORDER BY created_at, id LIMIT ?`,
        )
        .all(workspaceId, botId, RUN_STATS_LIST_MAX) as {
        id: string;
        status: RunStatus;
        lane: RunLane;
        created_at: string;
      }[]
    ).map(
      (row): RunStatsParkedRun => ({
        runId: row.id as RunId,
        status: row.status,
        lane: row.lane,
        createdAt: row.created_at,
      }),
    );
    return { total, byStatus, items };
  }

  executingRuns(): number {
    const { botId, workspaceId } = this.scope;
    return this.count(
      `SELECT count(*) AS n FROM runs WHERE workspace_id = ? AND bot_id = ?
          AND status IN (${sqlList(EXECUTING_RUN_STATUSES)})`,
      workspaceId,
      botId,
    );
  }

  tasks(): RunStatsReport["now"]["tasks"] {
    const { botId, workspaceId } = this.scope;
    const own = "workspace_id = ? AND owner_bot_id = ? AND deleted_at IS NULL";
    const byStatus: Partial<Record<TaskStatus, number>> = {};
    for (const row of this.db
      .prepare(`SELECT status, count(*) AS n FROM tasks WHERE ${own} GROUP BY status`)
      .all(workspaceId, botId) as { status: TaskStatus; n: number }[])
      byStatus[row.status] = row.n;
    const open = `${own} AND status IN (${sqlList(OPEN_TASK_STATUSES)})`;
    const items = (
      this.db
        .prepare(
          `SELECT id, status, title, updated_at FROM tasks WHERE ${open}
            ORDER BY updated_at DESC, id LIMIT ?`,
        )
        .all(workspaceId, botId, RUN_STATS_LIST_MAX) as {
        id: string;
        status: TaskStatus;
        title: string;
        updated_at: string;
      }[]
    ).map(
      (row): RunStatsTask => ({
        taskId: row.id,
        status: row.status,
        title: row.title,
        updatedAt: row.updated_at,
      }),
    );
    return {
      byStatus,
      open: {
        total: this.count(`SELECT count(*) AS n FROM tasks WHERE ${open}`, workspaceId, botId),
        items,
      },
    };
  }
}

/** Succeeded and silent over terminal runs; null when the window has no terminal run. */
function successShare(w: RunStatsWindow): number | null {
  let terminal = 0;
  for (const status of TERMINAL_RUN_STATUSES) terminal += w.byStatus[status] ?? 0;
  if (terminal === 0) return null;
  return round(((w.byStatus.succeeded ?? 0) + (w.byStatus.silent ?? 0)) / terminal);
}

const delta = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.round((a - b) * 1e6) / 1e6;

/** The whole answer for one call; `now` is the clock the windows end at. */
export function computeRunStats(
  db: GatewayDb,
  scope: RunStatsScope,
  windowDays: number,
  now: Date = new Date(),
): RunStatsReport {
  const tenant = db
    .prepare("SELECT tenant_id FROM workspaces WHERE id = ?")
    .get(scope.workspaceId) as { tenant_id: string } | undefined;
  const tenantId = tenant?.tenant_id ?? "";
  const q = new RunStatsQuery(db, scope);
  const today = now.getTime();
  const current = q.window(day(today - (windowDays - 1) * DAY_MS), day(today), tenantId);
  const previous = q.window(
    day(today - (2 * windowDays - 1) * DAY_MS),
    day(today - windowDays * DAY_MS),
    tenantId,
  );
  return {
    version: 1,
    botId: scope.botId,
    workspaceId: scope.workspaceId,
    runId: scope.runId,
    generatedAt: now.toISOString(),
    windowDays,
    current,
    previous,
    trend: {
      runs: current.runs - previous.runs,
      failed: (current.byStatus.failed ?? 0) - (previous.byStatus.failed ?? 0),
      successShare: { current: successShare(current), previous: successShare(previous) },
      knownCostUsd: delta(current.spend.knownCostUsd, previous.spend.knownCostUsd),
      medianSeconds: delta(current.durations.medianSeconds, previous.durations.medianSeconds),
    },
    now: {
      executingRuns: q.executingRuns(),
      pendingApprovals: q.pendingApprovals(),
      parkedRuns: q.parkedRuns(),
      tasks: q.tasks(),
    },
  };
}
