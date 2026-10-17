// The stored per-run usage summary (ADR-0032 amendment 1, issue #113). One row per run with its
// receipt coverage and one row per run and model with the counts the Costs page groups: tokens,
// receipt rows, priced, unpriced, observational-unpriced, estimated, unestimated and unmeasured
// rows, known cost, estimated cost and uncertain attribution. Written when an attempt ends; SQLite
// triggers delete it when any of its inputs change; a reader computes what is missing (the lazy
// backfill). A price-table edit rewrites nothing: history is not re-priced.

import { PRICE_ESTIMATE_VERSION, type RunId, type UsageCoverage } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { EstimateCache, estimateCost, measured } from "./price-estimate.js";
import { PriceStore } from "./prices.js";
import { type UsageReceipts, usageReceiptsForRuns } from "./usage-receipts.js";

/** One model's share of one run, as stored. */
export interface ModelUsageSummary {
  model: string;
  usageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  pricedUsageCount: number;
  unpricedUsageCount: number;
  /** Unpriced rows that are observations (they carry a coverage): lower bounds while in flight. */
  observedUnpricedCount: number;
  estimatedUsageCount: number;
  unestimatedUsageCount: number;
  unmeasuredUsageCount: number;
  /** Null when no row of the model was priced (unpriced, not free). */
  knownCostUsd: number | null;
  /** Null when no row of the model was estimated. */
  estimatedCostUsd: number | null;
  attributionUncertain: boolean;
}

export interface RunUsageSummary {
  runId: RunId;
  coverage: UsageCoverage;
  models: ModelUsageSummary[];
}

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * The summary of one receipt, with the same per-row rules the Costs page used to apply on every
 * request: a priced row adds known cost, an unpriced measured row an estimate at the run's pricing
 * time, or counts as unestimated; an unpriced unmeasured row counts as unmeasured.
 */
export function summarizeReceipt(
  runId: RunId,
  receipt: UsageReceipts,
  estimates: EstimateCache,
  pricedAt: string,
): RunUsageSummary {
  const byModel = new Map<string, ModelUsageSummary>();
  for (const row of receipt.rows) {
    let m = byModel.get(row.model);
    if (!m) {
      m = {
        model: row.model,
        usageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        pricedUsageCount: 0,
        unpricedUsageCount: 0,
        observedUnpricedCount: 0,
        estimatedUsageCount: 0,
        unestimatedUsageCount: 0,
        unmeasuredUsageCount: 0,
        knownCostUsd: null,
        estimatedCostUsd: null,
        attributionUncertain: false,
      };
      byModel.set(row.model, m);
    }
    m.usageCount++;
    m.inputTokens += row.inputTokens ?? 0;
    m.outputTokens += row.outputTokens ?? 0;
    m.cacheReadTokens += row.cacheReadTokens ?? 0;
    m.cacheCreateTokens += row.cacheCreateTokens ?? 0;
    if (row.attributionUncertain) m.attributionUncertain = true;
    if (row.costUsd === null) {
      m.unpricedUsageCount++;
      if (row.coverage !== undefined) m.observedUnpricedCount++;
      const estimate = estimateCost(estimates.at(pricedAt), row);
      if (estimate !== null) {
        m.estimatedCostUsd = micro((m.estimatedCostUsd ?? 0) + estimate);
        m.estimatedUsageCount++;
      } else if (measured(row)) m.unestimatedUsageCount++;
      else m.unmeasuredUsageCount++;
    } else {
      m.pricedUsageCount++;
      m.knownCostUsd = micro((m.knownCostUsd ?? 0) + row.costUsd);
    }
  }
  return { runId, coverage: receipt.coverage, models: [...byModel.values()] };
}

interface RunPricing {
  id: RunId;
  workspace_id: string;
  priced_at: string;
}

export class RunUsageSummaryStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Compute and store the summaries of these runs now, replacing any stored ones. */
  refresh(runIds: readonly RunId[]): void {
    const ids = [...new Set(runIds)];
    if (!ids.length) return;
    const runs: RunPricing[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      runs.push(
        ...(this.db
          .prepare(
            `SELECT id, workspace_id, coalesce(started_at, created_at) AS priced_at FROM runs
              WHERE id IN (${chunk.map(() => "?").join(",")})`,
          )
          .all(...chunk) as RunPricing[]),
      );
    }
    if (!runs.length) return;
    const receipts = usageReceiptsForRuns(
      this.db,
      runs.map((r) => r.id),
    );
    const estimates = new EstimateCache(new PriceStore(this.db).list());
    const at = this.now().toISOString();
    const insertRun = this.db.prepare(
      `INSERT INTO run_usage_summaries (run_id, workspace_id, coverage, estimate_version, computed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertModel = this.db.prepare(
      `INSERT INTO run_usage_summary_models (run_id, workspace_id, model, usage_count,
         input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, priced_usage_count,
         unpriced_usage_count, observed_unpriced_count, estimated_usage_count,
         unestimated_usage_count, unmeasured_usage_count, known_cost_usd, estimated_cost_usd,
         attribution_uncertain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const remove = this.db.prepare("DELETE FROM run_usage_summaries WHERE run_id = ?");
    this.db.transaction(() => {
      for (const run of runs) {
        const receipt = receipts.get(run.id);
        if (!receipt) continue;
        const summary = summarizeReceipt(run.id, receipt, estimates, run.priced_at);
        remove.run(run.id);
        insertRun.run(run.id, run.workspace_id, summary.coverage, PRICE_ESTIMATE_VERSION, at);
        for (const m of summary.models)
          insertModel.run(
            run.id,
            run.workspace_id,
            m.model,
            m.usageCount,
            m.inputTokens,
            m.outputTokens,
            m.cacheReadTokens,
            m.cacheCreateTokens,
            m.pricedUsageCount,
            m.unpricedUsageCount,
            m.observedUnpricedCount,
            m.estimatedUsageCount,
            m.unestimatedUsageCount,
            m.unmeasuredUsageCount,
            m.knownCostUsd,
            m.estimatedCostUsd,
            m.attributionUncertain ? 1 : 0,
          );
      }
    })();
  }

  /**
   * Compute the summaries the selected runs lack: `fromWhere` is a `FROM runs r ... WHERE ...`
   * clause and its parameters. This is the lazy backfill of runs that predate the table and of
   * runs whose summary a later usage write invalidated.
   */
  ensure(fromWhere: string, params: readonly unknown[]): void {
    const missing = this.db
      .prepare(
        `SELECT r.id ${fromWhere}
           AND NOT EXISTS (SELECT 1 FROM run_usage_summaries s WHERE s.run_id = r.id)`,
      )
      .all(...params) as { id: RunId }[];
    this.refresh(missing.map((r) => r.id));
  }

  get(runId: RunId): RunUsageSummary | undefined {
    const run = this.db
      .prepare("SELECT coverage FROM run_usage_summaries WHERE run_id = ?")
      .get(runId) as { coverage: UsageCoverage } | undefined;
    if (!run) return undefined;
    const rows = this.db
      .prepare(
        `SELECT model, usage_count AS usageCount, input_tokens AS inputTokens,
                output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
                cache_create_tokens AS cacheCreateTokens, priced_usage_count AS pricedUsageCount,
                unpriced_usage_count AS unpricedUsageCount,
                observed_unpriced_count AS observedUnpricedCount,
                estimated_usage_count AS estimatedUsageCount,
                unestimated_usage_count AS unestimatedUsageCount,
                unmeasured_usage_count AS unmeasuredUsageCount, known_cost_usd AS knownCostUsd,
                estimated_cost_usd AS estimatedCostUsd,
                attribution_uncertain AS attributionUncertain
           FROM run_usage_summary_models WHERE run_id = ? ORDER BY model`,
      )
      .all(runId) as (Omit<ModelUsageSummary, "attributionUncertain"> & {
      attributionUncertain: number;
    })[];
    return {
      runId,
      coverage: run.coverage,
      models: rows.map((r) => ({ ...r, attributionUncertain: r.attributionUncertain === 1 })),
    };
  }
}

/** ADR-0032 amendment 1 decision 12: what `RunLifecycle.ended` calls once the attempt's usage is in. */
export function refreshRunUsageSummary(db: GatewayDb, runId: RunId): void {
  new RunUsageSummaryStore(db).refresh([runId]);
}
