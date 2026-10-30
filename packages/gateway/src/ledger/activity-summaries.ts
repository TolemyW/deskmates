// Activity summaries (ADR-0033). A long terminal run gets one recorded, tool-free summary job per
// source version; a run whose outcome already fits the bound is shown verbatim with no job. The
// Gateway never calls a model: it queues the job and stores the bounded text the sidecar returns.

import {
  ACTIVITY_SUMMARY_MAX_VERSIONS,
  ACTIVITY_SUMMARY_SOURCE_MAX,
  type ActivitySummary,
  type MessageId,
  type RunId,
  type RunStatus,
  boundActivitySummary,
  fitsActivitySummary,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { EventBus } from "../events/bus.js";
import { modelsForJob } from "../scheduler/job-models.js";
import type { RunRecord, RunStore } from "./runs.js";

export const ACTIVITY_SUMMARY = "activity_summary";

/** Decision 4: the statuses whose outcome may need a model to shorten. */
const SUMMARIZED: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "stopped"]);

interface SummaryRow {
  run_id: string;
  source_version: string;
  status: "pending" | "ready" | "failed";
  text: string | null;
  summary_run_id: string | null;
}

export interface ActivitySummaryDeps {
  db: GatewayDb;
  runs: RunStore;
  runConfig: () => Record<string, unknown>;
  /** CHEAP_MODEL, frozen on each job (decision 6, `scheduler/job-models.ts`). */
  cheapModel: () => string;
  /** The text of a thread message, for the request part of the source. */
  messageBody: (id: MessageId) => string | undefined;
}

export function sourceVersionOf(run: Pick<RunRecord, "attempt" | "status">): string {
  return `a${run.attempt}-${run.status}`;
}

/** What the card would show without a model: the reply, else what was done, else the error. */
export function outcomeTextOf(run: Pick<RunRecord, "status" | "summary" | "error">): string {
  if (run.status === "failed" || run.status === "stopped")
    return (run.error ?? run.summary?.reply ?? "").trim();
  return (run.summary?.reply || run.summary?.done || "").trim();
}

export class ActivitySummaryStore {
  constructor(private readonly deps: ActivitySummaryDeps) {}

  private get db(): GatewayDb {
    return this.deps.db;
  }

  /**
   * Decisions 4 and 5: called whenever a run's status is published. Queues at most one job per
   * source version, and none for a short outcome, a non-summarized status, a summary job, or a
   * run past its version allowance. Returns the queued job, if any.
   */
  onRunStatus(run: RunRecord): RunRecord | undefined {
    if (run.config.runType !== undefined) return undefined;
    if (!SUMMARIZED.has(run.status)) return undefined;
    const outcome = outcomeTextOf(run);
    if (fitsActivitySummary(outcome)) return undefined;
    const version = sourceVersionOf(run);
    return this.db.transaction(() => {
      const versions = this.db
        .prepare("SELECT count(*) AS n FROM run_activity_summaries WHERE run_id = ?")
        .get(run.id) as { n: number };
      if (versions.n >= ACTIVITY_SUMMARY_MAX_VERSIONS) return undefined;
      const at = nowIso();
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO run_activity_summaries
             (run_id, source_version, workspace_id, status, created_at, updated_at)
           SELECT id, ?, workspace_id, 'pending', ?, ? FROM runs WHERE id = ?`,
        )
        .run(version, at, at, run.id);
      if (inserted.changes === 0) return undefined;
      const job = this.deps.runs.create({
        botId: run.botId,
        lane: "background",
        triggerKind: "model_job",
        triggerRef: `${ACTIVITY_SUMMARY}:${run.id}:${version}`,
        triggerPayload: { prompt: this.sourceOf(run) },
        config: {
          ...this.deps.runConfig(),
          runType: ACTIVITY_SUMMARY,
          sourceRunId: run.id,
          sourceVersion: version,
          ...modelsForJob(ACTIVITY_SUMMARY, this.deps.cheapModel()),
          maxTurns: 1,
          presentationVersion: 1,
        },
      });
      this.db
        .prepare(
          "UPDATE run_activity_summaries SET summary_run_id = ? WHERE run_id = ? AND source_version = ?",
        )
        .run(job.id, run.id, version);
      return job;
    })();
  }

  /** Decision 6/7: the job ended. Only the summary row changes. */
  complete(job: RunRecord, text: string | undefined): void {
    const runId = job.config.sourceRunId;
    const version = job.config.sourceVersion;
    if (typeof runId !== "string" || typeof version !== "string") return;
    const bounded = text ? boundActivitySummary(text) : "";
    this.db
      .prepare(
        `UPDATE run_activity_summaries SET status = ?, text = ?, updated_at = ?
         WHERE run_id = ? AND source_version = ? AND summary_run_id = ?`,
      )
      .run(bounded ? "ready" : "failed", bounded || null, nowIso(), runId, version, job.id);
  }

  /**
   * The summary each run shows now (decision 5): the row of its current source version, the
   * verbatim outcome when it fits, else nothing. A row of an older version is never returned.
   */
  forRuns(runs: readonly RunRecord[]): Map<RunId, ActivitySummary> {
    const out = new Map<RunId, ActivitySummary>();
    if (runs.length === 0) return out;
    const rows = this.db
      .prepare(
        "SELECT * FROM run_activity_summaries WHERE run_id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(runs.map((r) => r.id))) as SummaryRow[];
    for (const run of runs) {
      if (!SUMMARIZED.has(run.status) || run.config.runType !== undefined) continue;
      const version = sourceVersionOf(run);
      const outcome = outcomeTextOf(run);
      if (outcome && fitsActivitySummary(outcome)) {
        out.set(run.id, {
          runId: run.id,
          sourceVersion: version,
          status: "ready",
          text: outcome,
          verbatim: true,
        });
        continue;
      }
      const row = rows.find((r) => r.run_id === run.id && r.source_version === version);
      if (!row) continue;
      out.set(run.id, {
        runId: run.id,
        sourceVersion: version,
        status: row.status,
        ...(row.text ? { text: row.text } : {}),
        ...(row.summary_run_id ? { summaryRunId: row.summary_run_id as RunId } : {}),
      });
    }
    return out;
  }

  /** The bounded, redaction-free source; the sidecar redacts and wraps it as untrusted. */
  private sourceOf(run: RunRecord): string {
    const request =
      run.triggerKind === "thread_message"
        ? this.deps.messageBody(run.triggerRef as MessageId)
        : typeof run.triggerPayload?.prompt === "string"
          ? run.triggerPayload.prompt
          : undefined;
    const parts = [
      `status: ${run.status}`,
      request ? `request: ${request.slice(0, 800)}` : "",
      run.summary?.done ? `done: ${run.summary.done}` : "",
      run.summary?.reply ? `reply: ${run.summary.reply}` : "",
      run.error ? `error: ${run.error}` : "",
    ].filter(Boolean);
    return parts.join("\n").slice(0, ACTIVITY_SUMMARY_SOURCE_MAX);
  }
}

/**
 * The store, subscribed to run status changes: a run that reaches a summarized status queues its
 * job after the transaction that ended it has committed (the bus publishes after commit).
 */
export function createActivitySummaries(
  deps: ActivitySummaryDeps & { bus: EventBus },
): ActivitySummaryStore {
  const store = new ActivitySummaryStore(deps);
  deps.bus.subscribe((event) => {
    if (event.type !== "run_status") return;
    const job = store.onRunStatus(event.run);
    if (job) deps.bus.publish({ type: "run_status", run: job });
  });
  return store;
}
