// Run ledger retention (issue #11, ADR-0042 decision 6). Off unless `RUN_EVENTS_RETENTION_DAYS`
// is set. When on, a terminal run that finished more than that many days ago loses its
// `run_events`, `run_usage` and `model_requests` rows; the run row, its summary, its Activity
// summary (`run_activity_summaries`), its approvals and marks stay. A run with an approval nobody
// has decided is never pruned, whatever its status.
//
// Costs keep the run: its stored usage summary (`run_usage_summaries`, ADR-0032 amendment 1) is
// computed before the usage rows go and written back after them, because the summary triggers
// delete it the moment a usage row is deleted, and a reader would otherwise recompute it from
// nothing. Budget spend is its own ledger (`budget_charges`) and is untouched.
//
// Export before prune is the operator's job (`npm run replay -- export`, a database backup);
// nothing here exports. Each pruned run leaves one `run_retention_prunes` row saying when and how
// much, which is also what makes a pass idempotent.

import { type RunId, type RunStatus, isTerminal } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { RunUsageSummaryStore } from "./run-usage-summaries.js";

/** How often the Gateway runs a pass while retention is on. */
export const RUN_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Runs pruned per pass at most, oldest first, so one pass never holds the database for long. */
export const RUN_RETENTION_BATCH = 200;

const TERMINAL_STATUSES: readonly RunStatus[] = (
  [
    "queued",
    "running",
    "waiting_approval_live",
    "waiting_approval",
    "waiting_browser",
    "waiting_continuation",
    "succeeded",
    "silent",
    "failed",
    "cancelled",
    "stopped",
  ] as const satisfies readonly RunStatus[]
).filter((status) => isTerminal(status));

export interface RunPruneResult {
  runs: number;
  events: number;
  usage: number;
  requests: number;
}

interface Candidate {
  id: RunId;
  workspace_id: string;
}

/**
 * Terminal runs finished before `cutoff` with nothing pending, not yet pruned, oldest first.
 * `created_at` is bounded too, so `runs_status_created` narrows the scan.
 */
function candidates(db: GatewayDb, cutoff: string, limit: number): Candidate[] {
  const statuses = TERMINAL_STATUSES.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT r.id, r.workspace_id FROM runs r
        WHERE r.status IN (${statuses}) AND r.created_at < ?
          AND coalesce(r.finished_at, r.created_at) < ?
          AND NOT EXISTS (SELECT 1 FROM run_retention_prunes p WHERE p.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.decision IS NULL)
        ORDER BY r.created_at, r.id LIMIT ?`,
    )
    .all(...TERMINAL_STATUSES, cutoff, cutoff, limit) as Candidate[];
}

/**
 * One retention pass. `retentionDays` undefined or not positive does nothing (the default).
 * Returns what was removed.
 */
export function pruneRunLedger(
  db: GatewayDb,
  retentionDays: number | undefined,
  now: Date = new Date(),
  limit: number = RUN_RETENTION_BATCH,
): RunPruneResult {
  const result: RunPruneResult = { runs: 0, events: 0, usage: 0, requests: 0 };
  if (retentionDays === undefined || !(retentionDays > 0)) return result;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const summaries = new RunUsageSummaryStore(db, () => now);
  const readSummary = db.prepare("SELECT * FROM run_usage_summaries WHERE run_id = ?");
  const readModels = db.prepare("SELECT * FROM run_usage_summary_models WHERE run_id = ?");
  const deleteEvents = db.prepare("DELETE FROM run_events WHERE run_id = ?");
  const deleteUsage = db.prepare("DELETE FROM run_usage WHERE run_id = ?");
  const deleteRequests = db.prepare("DELETE FROM model_requests WHERE run_id = ?");
  const record = db.prepare(
    `INSERT INTO run_retention_prunes (run_id, workspace_id, pruned_at, retention_days,
       event_count, usage_count, request_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const pruneOne = db.transaction((run: Candidate) => {
    // The summary as of now, from the rows about to go; restored once they are gone.
    if (readSummary.get(run.id) === undefined) summaries.refresh([run.id]);
    const summary = readSummary.get(run.id) as Record<string, unknown> | undefined;
    const models = readModels.all(run.id) as Record<string, unknown>[];
    const events = deleteEvents.run(run.id).changes;
    const usage = deleteUsage.run(run.id).changes;
    const requests = deleteRequests.run(run.id).changes;
    if (summary) {
      restore(db, "run_usage_summaries", summary);
      for (const model of models) restore(db, "run_usage_summary_models", model);
    }
    record.run(run.id, run.workspace_id, nowIso(), retentionDays, events, usage, requests);
    result.runs += 1;
    result.events += events;
    result.usage += usage;
    result.requests += requests;
  });
  for (const run of candidates(db, cutoff, limit)) pruneOne(run);
  return result;
}

/** Re-insert a row read with `SELECT *`; column names come from the database, not from input. */
function restore(db: GatewayDb, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column]));
}

/** When the run's ledger was pruned, if it was. */
export function prunedAt(db: GatewayDb, runId: RunId): string | undefined {
  const row = db
    .prepare("SELECT pruned_at FROM run_retention_prunes WHERE run_id = ?")
    .get(runId) as { pruned_at: string } | undefined;
  return row?.pruned_at;
}

/**
 * The hourly pass while retention is on; `start` does nothing when it is off. A failed pass is
 * logged and the next one tries again.
 */
export class RunRetention {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: GatewayDb,
    private readonly retentionDays: number | undefined,
    private readonly log: (msg: string, data?: Record<string, unknown>) => void = () => {},
    private readonly intervalMs: number = RUN_RETENTION_INTERVAL_MS,
  ) {}

  get enabled(): boolean {
    return this.retentionDays !== undefined && this.retentionDays > 0;
  }

  /** One pass now; returns what it removed. */
  pass(now: Date = new Date()): RunPruneResult {
    const result = pruneRunLedger(this.db, this.retentionDays, now);
    if (result.runs > 0) this.log("run ledger retention pruned runs", { ...result });
    return result;
  }

  start(): void {
    if (!this.enabled || this.timer !== undefined) return;
    const safePass = () => {
      try {
        this.pass();
      } catch (err) {
        this.log("run ledger retention pass failed", { error: String(err) });
      }
    };
    safePass();
    this.timer = setInterval(safePass, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
