// Operator cost reporting. Observed costs are lower bounds; unknown runs remain visible even
// without a final SDK aggregate.
//
// ADR-0032: unpriced usage also carries an estimate at the average configured unit price per
// token category, reported apart from known cost. Totals, days and rankings are grouped here, on
// the server, over the whole filtered range; a ranking page never recomputes a total.
//
// ADR-0032 amendment 1 (#113): every figure comes from the stored per-run, per-model usage
// summaries (`run-usage-summaries.ts`) grouped with SQL; a run without a summary is computed once
// and stored before the query. Whether a run is in flight is read at query time from its status.
import {
  COST_RANKING_PAGE_SIZE,
  type CostDay,
  type CostQuery,
  type CostRankingDimension,
  type CostRankingEntry,
  type CostRankingMetric,
  type CostRankingPage,
  type CostReport,
  type CostRow,
  type CostTotals,
  PRICE_ESTIMATE_VERSION,
  type RunId,
  TERMINAL_RUN_STATUSES,
  type UsageCoverage,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { EstimateCache, estimateCost, measured } from "./price-estimate.js";
import { PriceStore } from "./prices.js";
import { RunUsageSummaryStore } from "./run-usage-summaries.js";
import { combineCoverage, usageReceiptsForRuns } from "./usage-receipts.js";

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** The grouped sums of one group of summary rows. */
interface SumRow {
  run_count: number;
  usage_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  priced_usage_count: number;
  unpriced_usage_count: number;
  known_cost_usd: number | null;
  estimated_cost_usd: number | null;
  estimated_usage_count: number;
  unestimated_usage_count: number;
  attribution_uncertain: number;
  coverages: string | null;
}

const TERMINAL = [...TERMINAL_RUN_STATUSES].map((s) => `'${s}'`).join(", ");

/** The aggregate columns every grouping selects; `m` is a summary model row, `r` its run. */
const SUMS = `count(DISTINCT m.run_id) AS run_count,
  sum(m.usage_count) AS usage_count,
  sum(m.input_tokens) AS input_tokens,
  sum(m.output_tokens) AS output_tokens,
  sum(m.cache_read_tokens) AS cache_read_tokens,
  sum(m.cache_create_tokens) AS cache_create_tokens,
  sum(m.priced_usage_count) AS priced_usage_count,
  sum(m.unpriced_usage_count -
      CASE WHEN r.status IN (${TERMINAL}) THEN 0 ELSE m.observed_unpriced_count END)
    AS unpriced_usage_count,
  sum(m.known_cost_usd) AS known_cost_usd,
  sum(m.estimated_cost_usd) AS estimated_cost_usd,
  sum(m.estimated_usage_count) AS estimated_usage_count,
  sum(m.unestimated_usage_count) AS unestimated_usage_count,
  max(m.attribution_uncertain) AS attribution_uncertain,
  group_concat(DISTINCT s.coverage) AS coverages`;

const coveragesOf = (list: string | null): UsageCoverage[] =>
  list ? (list.split(",") as UsageCoverage[]) : [];

/**
 * The totals of one group, shaped and finished exactly as the per-request computation did: the
 * counters, then the group's own fields (`extra`), then the uncertainty flag and the coverage.
 */
function totalsOf<E extends object>(
  row: SumRow | undefined,
  extra: E,
  coverage?: UsageCoverage[],
): CostTotals & E {
  const pricedUsageCount = row?.priced_usage_count ?? 0;
  const unpricedUsageCount = row?.unpriced_usage_count ?? 0;
  const estimatedUsageCount = row?.estimated_usage_count ?? 0;
  const base: CostTotals = {
    runCount: row?.run_count ?? 0,
    usageCount: row?.usage_count ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    cacheCreateTokens: row?.cache_create_tokens ?? 0,
    pricedUsageCount,
    unpricedUsageCount,
    knownCostUsd:
      pricedUsageCount && typeof row?.known_cost_usd === "number"
        ? micro(row.known_cost_usd)
        : null,
    costStatus: "unpriced",
    estimatedCostUsd:
      estimatedUsageCount && typeof row?.estimated_cost_usd === "number"
        ? micro(row.estimated_cost_usd)
        : null,
    estimatedUsageCount,
    unestimatedUsageCount: row?.unestimated_usage_count ?? 0,
  };
  const t = Object.assign(base, extra) as CostTotals & E;
  if (row?.attribution_uncertain) t.attributionUncertain = true;
  const c = combineCoverage(coverage ?? coveragesOf(row?.coverages ?? null));
  // No runs, no coverage: an empty report is not "not started".
  if (c !== undefined) t.usageCoverage = c;
  t.costStatus =
    t.pricedUsageCount === 0
      ? "unpriced"
      : t.unpricedUsageCount || (c !== undefined && c !== "complete")
        ? "partial"
        : "priced";
  return t;
}

/** Activity order: newest day first, then bot name, bot id and model; unique per row. */
function compareRows(
  a: Pick<CostRow, "day" | "botName" | "botId" | "model">,
  b: Pick<CostRow, "day" | "botName" | "botId" | "model">,
): number {
  return (
    b.day.localeCompare(a.day) ||
    a.botName.localeCompare(b.botName) ||
    a.botId.localeCompare(b.botId) ||
    a.model.localeCompare(b.model)
  );
}

const tokenTotal = (t: CostTotals) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreateTokens;

/** Known plus estimated USD, or null when the entry has neither (it is unpriced, not free). */
export function moneyOf(t: CostTotals): number | null {
  if (t.knownCostUsd === null && (t.estimatedCostUsd ?? null) === null) return null;
  return micro((t.knownCostUsd ?? 0) + (t.estimatedCostUsd ?? 0));
}

/** The run filter of a query: `FROM runs r JOIN bots b JOIN workspaces w WHERE ...`. */
function runFilter(tenantId: string, query: CostQuery): { sql: string; params: string[] } {
  const clauses = ["w.tenant_id = ?"];
  const params: string[] = [tenantId];
  if (query.from) {
    clauses.push("substr(r.created_at, 1, 10) >= ?");
    params.push(query.from);
  }
  if (query.to) {
    clauses.push("substr(r.created_at, 1, 10) <= ?");
    params.push(query.to);
  }
  if (query.workspaceId) {
    clauses.push("r.workspace_id = ?");
    params.push(query.workspaceId);
  }
  if (query.botId) {
    clauses.push("r.bot_id = ?");
    params.push(query.botId);
  }
  return {
    sql: `FROM runs r JOIN bots b ON b.id = r.bot_id JOIN workspaces w ON w.id = r.workspace_id
          WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

export class CostQueryStore {
  private readonly summaries: RunUsageSummaryStore;

  constructor(private readonly db: GatewayDb) {
    this.summaries = new RunUsageSummaryStore(db);
  }

  /**
   * The grouped sums over the stored summaries of the selected runs, after computing the missing
   * ones. `select` names the group columns, `group` the GROUP BY list (empty for one total).
   */
  private grouped<T extends object>(
    tenantId: string,
    query: CostQuery,
    select: string,
    group: string,
  ): (SumRow & T)[] {
    const filter = runFilter(tenantId, query);
    this.summaries.ensure(filter.sql, filter.params);
    const model = query.model ? " AND m.model = ?" : "";
    const params = query.model ? [...filter.params, query.model] : filter.params;
    return this.db
      .prepare(
        `SELECT ${select ? `${select}, ` : ""}${SUMS}
           ${filter.sql.replace(
             "WHERE",
             `JOIN run_usage_summaries s ON s.run_id = r.id
              JOIN run_usage_summary_models m ON m.run_id = r.id
              WHERE`,
           )}${model}
           ${group ? `GROUP BY ${group}` : ""}`,
      )
      .all(...params) as (SumRow & T)[];
  }

  /**
   * Coverage of every selected run with a summary, usage rows or not; with a model filter only
   * the runs that used the model (a filter cannot attribute a run whose model is unknown).
   */
  private coverage(tenantId: string, query: CostQuery): UsageCoverage[] {
    const filter = runFilter(tenantId, query);
    const model = query.model
      ? " AND EXISTS (SELECT 1 FROM run_usage_summary_models m WHERE m.run_id = r.id AND m.model = ?)"
      : "";
    const params = query.model ? [...filter.params, query.model] : filter.params;
    return (
      this.db
        .prepare(
          `SELECT DISTINCT s.coverage
             ${filter.sql.replace("WHERE", "JOIN run_usage_summaries s ON s.run_id = r.id WHERE")}${model}`,
        )
        .all(...params) as { coverage: UsageCoverage }[]
    ).map((row) => row.coverage);
  }

  private rows(tenantId: string, query: CostQuery): CostRow[] {
    const groups = this.grouped<{
      day: string;
      bot_id: CostRow["botId"];
      bot_name: string;
      model: string;
      workspace_id: WorkspaceId;
      workspace_name: string;
    }>(
      tenantId,
      query,
      `substr(r.created_at, 1, 10) AS day, r.bot_id, b.name AS bot_name, m.model,
       r.workspace_id, w.name AS workspace_name`,
      "substr(r.created_at, 1, 10), r.bot_id, m.model",
    );
    return groups
      .map(
        (g): CostRow =>
          totalsOf(g, {
            day: g.day,
            botId: g.bot_id,
            botName: g.bot_name,
            model: g.model,
            workspaceId: g.workspace_id,
            workspaceName: g.workspace_name,
          }),
      )
      .sort(compareRows);
  }

  report(tenantId: string, query: CostQuery = {}): CostReport & { rows: CostRow[] } {
    const [total] = this.grouped(tenantId, query, "", "");
    const totals = totalsOf(
      total && total.usage_count !== null ? total : undefined,
      {},
      this.coverage(tenantId, query),
    );
    const days = this.grouped<{ day: string }>(
      tenantId,
      query,
      "substr(r.created_at, 1, 10) AS day",
      "substr(r.created_at, 1, 10)",
    )
      .map((g): CostDay => totalsOf(g, { day: g.day }))
      .sort((a, b) => a.day.localeCompare(b.day));
    return {
      filters: { ...query },
      totals,
      rows: this.rows(tenantId, query),
      days,
      estimate: { version: PRICE_ESTIMATE_VERSION },
    };
  }

  /** Totals and days of the range without its rows: what `GET /api/costs` answers (#113). */
  summary(tenantId: string, query: CostQuery = {}): CostReport {
    const { rows: _rows, ...summary } = this.report(tenantId, query);
    return summary;
  }

  /**
   * The rows after the keyset `after` (`[day, botName, botId, model]`) in Activity order, at most
   * `limit + 1` so the caller can tell whether more follow, and the count of every row (#113).
   */
  rowPage(
    tenantId: string,
    query: CostQuery,
    limit: number,
    after?: readonly [string, string, string, string],
  ): { rows: CostRow[]; total: number } {
    const rows = this.rows(tenantId, query);
    const start = after
      ? rows.findIndex(
          (row) =>
            compareRows(row, {
              day: after[0],
              botName: after[1],
              botId: after[2] as CostRow["botId"],
              model: after[3],
            }) > 0,
        )
      : 0;
    return {
      rows: start < 0 ? [] : rows.slice(start, start + limit + 1),
      total: rows.length,
    };
  }

  /**
   * One page of a ranking over the whole filtered range (ADR-0032 decision 9). Money ranks known
   * plus estimated USD with unpriced entries last; usage ranks total tokens. `total` counts the
   * entries of the whole ranking.
   */
  ranking(
    tenantId: string,
    query: CostQuery,
    by: CostRankingDimension,
    metric: CostRankingMetric,
    offset = 0,
    limit = COST_RANKING_PAGE_SIZE,
  ): CostRankingPage {
    const groups = this.grouped<{
      key: string;
      label: string;
      workspace_id: WorkspaceId;
      workspace_name: string;
    }>(
      tenantId,
      query,
      by === "model"
        ? "m.model AS key, m.model AS label, NULL AS workspace_id, NULL AS workspace_name"
        : by === "bot"
          ? "r.bot_id AS key, b.name AS label, r.workspace_id, w.name AS workspace_name"
          : "r.workspace_id AS key, w.name AS label, NULL AS workspace_id, NULL AS workspace_name",
      by === "model" ? "m.model" : by === "bot" ? "r.bot_id" : "r.workspace_id",
    );
    const entries: CostRankingEntry[] = groups.map((g) =>
      totalsOf(g, {
        key: g.key,
        label: g.label,
        ...(by === "bot" ? { workspaceId: g.workspace_id, workspaceName: g.workspace_name } : {}),
      }),
    );
    entries.sort((a, b) => {
      if (metric === "money") {
        const ma = moneyOf(a);
        const mb = moneyOf(b);
        if (ma === null || mb === null) {
          if (ma !== mb) return ma === null ? 1 : -1;
        } else if (mb !== ma) return mb - ma;
      } else {
        const d = tokenTotal(b) - tokenTotal(a);
        if (d) return d;
      }
      return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
    });
    return {
      by,
      metric,
      filters: { ...query },
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      offset,
      limit,
    };
  }
}

/** A run's spend for the budget (ADR-0032 decision 3): known, estimated and the unknowns. */
export interface RunSpend {
  knownUsd: number;
  estimatedUsd: number;
  unmeasuredUsageCount: number;
  unestimatedUsageCount: number;
}

/**
 * The spend of one run, from the same receipts and estimate as the report. Live, not from the
 * stored summary: the budget charges while the attempt is still running (decision 3).
 */
export function runSpend(db: GatewayDb, runId: RunId): RunSpend | undefined {
  const run = db
    .prepare("SELECT coalesce(started_at, created_at) AS at FROM runs WHERE id = ?")
    .get(runId) as { at: string } | undefined;
  if (!run) return undefined;
  const receipt = usageReceiptsForRuns(db, [runId]).get(runId);
  const spend: RunSpend = {
    knownUsd: 0,
    estimatedUsd: 0,
    unmeasuredUsageCount: 0,
    unestimatedUsageCount: 0,
  };
  if (!receipt) return spend;
  let average: ReturnType<EstimateCache["at"]> | null = null;
  for (const row of receipt.rows) {
    if (row.costUsd !== null) {
      spend.knownUsd = micro(spend.knownUsd + row.costUsd);
      continue;
    }
    if (!measured(row)) {
      spend.unmeasuredUsageCount++;
      continue;
    }
    if (average === null) average = new EstimateCache(new PriceStore(db).list()).at(run.at);
    const estimate = estimateCost(average, row);
    if (estimate === null) spend.unestimatedUsageCount++;
    else spend.estimatedUsd = micro(spend.estimatedUsd + estimate);
  }
  return spend;
}
