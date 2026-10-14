// The workspace monetary budget (ADR-0032): limits, the charge ledger, admission verdicts and
// parks. Accounting only: nothing here calls a model or reserves money ahead of a call.

import {
  type BotId,
  type BudgetCheckpoint,
  type BudgetLimitKind,
  type BudgetLimits,
  type BudgetPark,
  type BudgetSpend,
  DeskmatesError,
  PRICE_ESTIMATE_VERSION,
  type RunId,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
  type ThreadId,
  type WorkspaceBudget,
  type WorkspaceId,
  weekEndUtc,
  weekStartUtc,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { runSpend } from "../ledger/costs.js";

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** What admission decided for a workspace at one instant (decision 5). */
export interface BudgetVerdict {
  exhausted: BudgetLimitKind | null;
  limitUsd?: number;
  spendUsd?: number;
  weekStartsAt: string;
}

interface LimitRow {
  weekly_limit_usd: number | null;
  cumulative_limit_usd: number | null;
  updated_by: string;
  updated_at: string;
}

interface SpendRow {
  known: number | null;
  estimated: number | null;
  unmeasured: number | null;
  unestimated: number | null;
}

interface ParkRow {
  id: string;
  workspace_id: WorkspaceId;
  run_id: RunId;
  attempt: number;
  checkpoint: BudgetCheckpoint;
  limit_kind: BudgetLimitKind;
  spend_usd: number;
  limit_usd: number;
  parked_at: string;
  bot_id: BotId;
  bot_name: string;
  thread_id: ThreadId | null;
  status: RunStatus;
}

const TERMINAL = [...TERMINAL_RUN_STATUSES];
const NOT_TERMINAL = `r.status NOT IN (${TERMINAL.map((s) => `'${s}'`).join(", ")})`;

function spendOf(row: SpendRow): BudgetSpend {
  const knownUsd = micro(row.known ?? 0);
  const estimatedUsd = micro(row.estimated ?? 0);
  return {
    knownUsd,
    estimatedUsd,
    totalUsd: micro(knownUsd + estimatedUsd),
    unmeasuredUsageCount: row.unmeasured ?? 0,
    unestimatedUsageCount: row.unestimated ?? 0,
  };
}

function validLimit(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new DeskmatesError("validation", `${name} must be a positive number of USD or null`, {
      [name]: value,
    });
  return value;
}

export class BudgetStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  limits(workspaceId: WorkspaceId): BudgetLimits & { updatedAt?: string; updatedBy?: string } {
    const row = this.db
      .prepare("SELECT * FROM workspace_budgets WHERE workspace_id = ?")
      .get(workspaceId) as LimitRow | undefined;
    if (!row) return { weeklyLimitUsd: null, cumulativeLimitUsd: null };
    return {
      weeklyLimitUsd: row.weekly_limit_usd,
      cumulativeLimitUsd: row.cumulative_limit_usd,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  /** Decision 1: set or clear both limits; one `budget.set` audit row in the same transaction. */
  setLimits(workspaceId: WorkspaceId, input: Record<string, unknown>, actor: string): BudgetLimits {
    const before = this.limits(workspaceId);
    const next: BudgetLimits = {
      weeklyLimitUsd:
        "weeklyLimitUsd" in input
          ? validLimit(input.weeklyLimitUsd, "weeklyLimitUsd")
          : before.weeklyLimitUsd,
      cumulativeLimitUsd:
        "cumulativeLimitUsd" in input
          ? validLimit(input.cumulativeLimitUsd, "cumulativeLimitUsd")
          : before.cumulativeLimitUsd,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspace_budgets (workspace_id, weekly_limit_usd, cumulative_limit_usd, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET weekly_limit_usd = excluded.weekly_limit_usd,
             cumulative_limit_usd = excluded.cumulative_limit_usd,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(
          workspaceId,
          next.weeklyLimitUsd,
          next.cumulativeLimitUsd,
          actor,
          this.now().toISOString(),
        );
      new AuditLog(this.db).record({
        action: "budget.set",
        actor,
        workspaceId,
        targetKind: "workspace_budget",
        targetId: workspaceId,
        before: {
          weeklyLimitUsd: before.weeklyLimitUsd,
          cumulativeLimitUsd: before.cumulativeLimitUsd,
        },
        after: next,
      });
    })();
    return next;
  }

  /**
   * Decision 3: append the difference between the run's spend now and what it was charged so
   * far. Idempotent when nothing changed. Returns whether a row was written.
   */
  charge(runId: RunId): boolean {
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT workspace_id FROM runs WHERE id = ?").get(runId) as
        | { workspace_id: WorkspaceId }
        | undefined;
      if (!run) return false;
      const spend = runSpend(this.db, runId);
      if (!spend) return false;
      const charged = this.db
        .prepare(
          `SELECT sum(known_usd) AS known, sum(estimated_usd) AS estimated,
                  sum(unmeasured_usage_delta) AS unmeasured, sum(unestimated_usage_delta) AS unestimated
             FROM budget_charges WHERE run_id = ?`,
        )
        .get(runId) as SpendRow;
      const known = micro(spend.knownUsd - (charged.known ?? 0));
      const estimated = micro(spend.estimatedUsd - (charged.estimated ?? 0));
      const unmeasured = spend.unmeasuredUsageCount - (charged.unmeasured ?? 0);
      const unestimated = spend.unestimatedUsageCount - (charged.unestimated ?? 0);
      if (!known && !estimated && !unmeasured && !unestimated) return false;
      this.db
        .prepare(
          `INSERT INTO budget_charges (workspace_id, run_id, charged_at, known_usd, estimated_usd,
             unmeasured_usage_delta, unestimated_usage_delta, estimate_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.workspace_id,
          runId,
          this.now().toISOString(),
          known,
          estimated,
          unmeasured,
          unestimated,
          estimated ? PRICE_ESTIMATE_VERSION : null,
        );
      return true;
    })();
  }

  /** Weekly (Monday 00:00 UTC) and cumulative spend of a workspace (decision 2). */
  spend(
    workspaceId: WorkspaceId,
    at: Date = this.now(),
  ): { week: BudgetSpend; cumulative: BudgetSpend } {
    const sql = `SELECT sum(known_usd) AS known, sum(estimated_usd) AS estimated,
        sum(unmeasured_usage_delta) AS unmeasured, sum(unestimated_usage_delta) AS unestimated
        FROM budget_charges WHERE workspace_id = ?`;
    const start = weekStartUtc(at).toISOString();
    const end = weekEndUtc(at).toISOString();
    return {
      week: spendOf(
        this.db
          .prepare(`${sql} AND charged_at >= ? AND charged_at < ?`)
          .get(workspaceId, start, end) as SpendRow,
      ),
      cumulative: spendOf(this.db.prepare(sql).get(workspaceId) as SpendRow),
    };
  }

  /** Decision 5: exhausted when either spend is at or above its limit; weekly checked first. */
  verdict(workspaceId: WorkspaceId, at: Date = this.now()): BudgetVerdict {
    const weekStartsAt = weekStartUtc(at).toISOString();
    const limits = this.limits(workspaceId);
    if (limits.weeklyLimitUsd === null && limits.cumulativeLimitUsd === null)
      return { exhausted: null, weekStartsAt };
    const spend = this.spend(workspaceId, at);
    if (limits.weeklyLimitUsd !== null && spend.week.totalUsd >= limits.weeklyLimitUsd)
      return {
        exhausted: "weekly",
        limitUsd: limits.weeklyLimitUsd,
        spendUsd: spend.week.totalUsd,
        weekStartsAt,
      };
    if (
      limits.cumulativeLimitUsd !== null &&
      spend.cumulative.totalUsd >= limits.cumulativeLimitUsd
    )
      return {
        exhausted: "cumulative",
        limitUsd: limits.cumulativeLimitUsd,
        spendUsd: spend.cumulative.totalUsd,
        weekStartsAt,
      };
    return { exhausted: null, weekStartsAt };
  }

  /** Decision 6: open a park for the run unless one is open. Returns the open park's id. */
  park(
    runId: RunId,
    attempt: number,
    checkpoint: BudgetCheckpoint,
    verdict: BudgetVerdict,
  ): { id: string; created: boolean } {
    return this.db.transaction(() => {
      const open = this.openPark(runId);
      if (open) return { id: open.id, created: false };
      if (!verdict.exhausted || verdict.limitUsd === undefined || verdict.spendUsd === undefined)
        throw new Error("budget park needs an exhausted verdict");
      const run = this.db.prepare("SELECT workspace_id FROM runs WHERE id = ?").get(runId) as {
        workspace_id: WorkspaceId;
      };
      const id = newId("budget_park");
      const parkedAt = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO budget_parks (id, workspace_id, run_id, attempt, checkpoint, limit_kind,
             spend_usd, limit_usd, week_starts_at, parked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          run.workspace_id,
          runId,
          attempt,
          checkpoint,
          verdict.exhausted,
          verdict.spendUsd,
          verdict.limitUsd,
          verdict.weekStartsAt,
          parkedAt,
        );
      return { id, created: true };
    })();
  }

  /** The open park of a run, if any. */
  openPark(
    runId: RunId,
  ): { id: string; attempt: number; checkpoint: BudgetCheckpoint } | undefined {
    return this.db
      .prepare(
        "SELECT id, attempt, checkpoint FROM budget_parks WHERE run_id = ? AND resolved_at IS NULL",
      )
      .get(runId) as { id: string; attempt: number; checkpoint: BudgetCheckpoint } | undefined;
  }

  /** Runs the scheduler must not start or resume: an open park on an unfinished run. */
  parkedRunIds(): Set<RunId> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT p.run_id FROM budget_parks p JOIN runs r ON r.id = p.run_id
              WHERE p.resolved_at IS NULL AND ${NOT_TERMINAL}`,
          )
          .all() as { run_id: RunId }[]
      ).map((r) => r.run_id),
    );
  }

  /** Runs a model-call park checkpointed whose park is closed: the scheduler resumes them. */
  resumableRunIds(): RunId[] {
    return (
      this.db
        .prepare(
          `SELECT r.id FROM runs r
            WHERE r.status = 'waiting_continuation'
              AND json_extract(r.resume_payload_json, '$.budget') = 1
              AND NOT EXISTS (SELECT 1 FROM budget_parks p WHERE p.run_id = r.id AND p.resolved_at IS NULL)
            ORDER BY r.created_at, r.id`,
        )
        .all() as { id: RunId }[]
    ).map((r) => r.id);
  }

  parks(workspaceId: WorkspaceId): BudgetPark[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.workspace_id, p.run_id, p.attempt, p.checkpoint, p.limit_kind, p.spend_usd,
                p.limit_usd, p.parked_at, r.bot_id, b.name AS bot_name, r.thread_id, r.status
           FROM budget_parks p JOIN runs r ON r.id = p.run_id JOIN bots b ON b.id = r.bot_id
          WHERE p.workspace_id = ? AND p.resolved_at IS NULL AND ${NOT_TERMINAL}
          ORDER BY p.parked_at, p.id`,
      )
      .all(workspaceId) as ParkRow[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      runId: r.run_id,
      botId: r.bot_id,
      botName: r.bot_name,
      ...(r.thread_id ? { threadId: r.thread_id } : {}),
      runStatus: r.status,
      attempt: r.attempt,
      checkpoint: r.checkpoint,
      limitKind: r.limit_kind,
      spendUsd: r.spend_usd,
      limitUsd: r.limit_usd,
      parkedAt: r.parked_at,
    }));
  }

  /**
   * Decision 7: an explicit continue. Refused while the workspace is still exhausted; closes the
   * open parks of the listed runs (all when none are listed) and writes one audit row.
   */
  continueParked(workspaceId: WorkspaceId, actor: string, runIds?: readonly RunId[]): RunId[] {
    return this.db.transaction(() => {
      const verdict = this.verdict(workspaceId);
      if (verdict.exhausted)
        throw new DeskmatesError(
          "budget_exhausted",
          `the workspace's ${verdict.exhausted} budget is still exhausted; raise or clear the limit first`,
          {
            workspaceId,
            limitKind: verdict.exhausted,
            limitUsd: verdict.limitUsd,
            spendUsd: verdict.spendUsd,
          },
        );
      const open = this.parks(workspaceId).filter((p) => !runIds || runIds.includes(p.runId));
      if (!open.length) return [];
      const at = this.now().toISOString();
      const close = this.db.prepare(
        "UPDATE budget_parks SET resolved_at = ?, resolved_by = ? WHERE id = ?",
      );
      for (const p of open) close.run(at, actor, p.id);
      new AuditLog(this.db).record({
        action: "budget.continue",
        actor,
        workspaceId,
        targetKind: "workspace_budget",
        targetId: workspaceId,
        after: { runIds: open.map((p) => p.runId) },
      });
      return open.map((p) => p.runId);
    })();
  }

  overview(workspaceId: WorkspaceId, workspaceName: string): WorkspaceBudget {
    const at = this.now();
    const { updatedAt, updatedBy, ...limits } = this.limits(workspaceId);
    const spend = this.spend(workspaceId, at);
    return {
      workspaceId,
      workspaceName,
      limits,
      ...(updatedAt ? { updatedAt } : {}),
      ...(updatedBy ? { updatedBy } : {}),
      week: {
        startsAt: weekStartUtc(at).toISOString(),
        endsAt: weekEndUtc(at).toISOString(),
        spend: spend.week,
      },
      cumulative: spend.cumulative,
      exhausted: this.verdict(workspaceId, at).exhausted,
      parks: this.parks(workspaceId),
    };
  }
}
