// Test support for ADR-0032 amendment 1 (issue #113): the Costs computation as it was before the
// stored run usage summaries, kept verbatim so tests can prove the SQL-grouped report, rows, days
// and rankings equal it on the same fixtures. It rebuilds every receipt per call; never use it in
// production code.
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
  type RunStatus,
  type UsageCoverage,
  type WorkspaceId,
  isTerminal,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { EstimateCache, estimateCost, measured } from "../ledger/price-estimate.js";
import { PriceStore } from "../ledger/prices.js";
import {
  type AttemptReceipt,
  combineCoverage,
  usageReceiptsForRuns,
} from "../ledger/usage-receipts.js";

function empty(): CostTotals {
  return {
    runCount: 0,
    usageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    pricedUsageCount: 0,
    unpricedUsageCount: 0,
    knownCostUsd: null,
    costStatus: "unpriced",
    estimatedCostUsd: null,
    estimatedUsageCount: 0,
    unestimatedUsageCount: 0,
  };
}

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

interface RunMeta {
  id: RunId;
  bot_id: CostRow["botId"];
  status: RunStatus;
  name: string;
  day: string;
  workspace_id: WorkspaceId;
  workspace_name: string;
  priced_at: string;
}

interface UsageFact {
  run: RunMeta;
  usage: AttemptReceipt;
  coverage: UsageCoverage;
  inFlight: boolean;
  /** Estimate for an unpriced row with measured tokens; null otherwise. */
  estimate: number | null;
}

interface Collected {
  facts: UsageFact[];
  /** Coverage of every selected run with a receipt, usage rows or not. */
  coverage: UsageCoverage[];
}

class Group<T extends CostTotals> {
  readonly runs = new Set<string>();
  readonly coverage: UsageCoverage[] = [];
  constructor(readonly row: T) {}

  add(f: UsageFact): void {
    const t = this.row;
    const u = f.usage;
    this.runs.add(f.run.id);
    this.coverage.push(f.coverage);
    if (u.attributionUncertain) t.attributionUncertain = true;
    t.usageCount++;
    for (const k of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreateTokens",
    ] as const)
      t[k] += u[k] ?? 0;
    if (u.costUsd === null) {
      if (!(f.inFlight && u.coverage !== undefined)) t.unpricedUsageCount++;
      if (f.estimate !== null) {
        t.estimatedCostUsd = micro((t.estimatedCostUsd ?? 0) + f.estimate);
        t.estimatedUsageCount = (t.estimatedUsageCount ?? 0) + 1;
      } else if (measured(u)) t.unestimatedUsageCount = (t.unestimatedUsageCount ?? 0) + 1;
    } else {
      t.pricedUsageCount++;
      t.knownCostUsd = micro((t.knownCostUsd ?? 0) + u.costUsd);
    }
  }

  finish(): T {
    finish(this.row, this.runs.size, this.coverage);
    return this.row;
  }
}

function finish(t: CostTotals, count: number, states: UsageCoverage[]): void {
  t.runCount = count;
  const c = combineCoverage(states);
  // No runs, no coverage: an empty report is not "not started".
  if (c !== undefined) t.usageCoverage = c;
  t.costStatus =
    t.pricedUsageCount === 0
      ? "unpriced"
      : t.unpricedUsageCount || (c !== undefined && c !== "complete")
        ? "partial"
        : "priced";
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
function moneyOf(t: CostTotals): number | null {
  if (t.knownCostUsd === null && (t.estimatedCostUsd ?? null) === null) return null;
  return micro((t.knownCostUsd ?? 0) + (t.estimatedCostUsd ?? 0));
}

export class LegacyCostQueryStore {
  constructor(private readonly db: GatewayDb) {}

  private collect(tenantId: string, query: CostQuery): Collected {
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
    const runs = this.db
      .prepare(
        `SELECT r.id, r.bot_id, r.status, b.name, substr(r.created_at, 1, 10) AS day,
                r.workspace_id, w.name AS workspace_name,
                coalesce(r.started_at, r.created_at) AS priced_at
           FROM runs r JOIN bots b ON b.id = r.bot_id JOIN workspaces w ON w.id = r.workspace_id
          WHERE ${clauses.join(" AND ")}`,
      )
      .all(...params) as RunMeta[];
    // One batched projection over the selected runs: a bounded number of statements however
    // many runs the range holds (the alert evaluator calls this per rule at every run end).
    const receipts = usageReceiptsForRuns(
      this.db,
      runs.map((r) => r.id),
    );
    const estimates = new EstimateCache(new PriceStore(this.db).list());
    const facts: UsageFact[] = [];
    const coverage: UsageCoverage[] = [];
    for (const run of runs) {
      const receipt = receipts.get(run.id);
      if (!receipt) continue;
      const rows = receipt.rows.filter((r) => !query.model || r.model === query.model);
      // A model filter cannot attribute a run whose model is unknown.
      if (query.model && !rows.length) continue;
      // A started run without measurements stays visible as unknown coverage; only runs with
      // usage rows are counted, as before receipts.
      coverage.push(receipt.coverage);
      // An in-flight run's observations are lower bounds still awaiting a priced final.
      const inFlight = !isTerminal(run.status);
      for (const usage of rows)
        facts.push({
          run,
          usage,
          coverage: receipt.coverage,
          inFlight,
          estimate:
            usage.costUsd === null ? estimateCost(estimates.at(run.priced_at), usage) : null,
        });
    }
    return { facts, coverage };
  }

  report(tenantId: string, query: CostQuery = {}): CostReport & { rows: CostRow[] } {
    const { facts, coverage } = this.collect(tenantId, query);
    const total = new Group(empty());
    const groups = new Map<string, Group<CostRow>>();
    const days = new Map<string, Group<CostDay>>();
    for (const f of facts) {
      total.add(f);
      const key = JSON.stringify([f.run.day, f.run.bot_id, f.usage.model]);
      let group = groups.get(key);
      if (!group) {
        group = new Group<CostRow>({
          ...empty(),
          day: f.run.day,
          botId: f.run.bot_id,
          botName: f.run.name,
          model: f.usage.model,
          workspaceId: f.run.workspace_id,
          workspaceName: f.run.workspace_name,
        });
        groups.set(key, group);
      }
      group.add(f);
      let day = days.get(f.run.day);
      if (!day) {
        day = new Group<CostDay>({ ...empty(), day: f.run.day });
        days.set(f.run.day, day);
      }
      day.add(f);
    }
    const totals = total.row;
    finish(totals, total.runs.size, coverage);
    const rows = [...groups.values()].map((g) => g.finish());
    rows.sort(compareRows);
    return {
      filters: { ...query },
      totals,
      rows,
      days: [...days.values()].map((d) => d.finish()).sort((a, b) => a.day.localeCompare(b.day)),
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
    const rows = this.report(tenantId, query).rows;
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
    const { facts } = this.collect(tenantId, query);
    const groups = new Map<string, Group<CostRankingEntry>>();
    for (const f of facts) {
      const key = by === "model" ? f.usage.model : by === "bot" ? f.run.bot_id : f.run.workspace_id;
      let group = groups.get(key);
      if (!group) {
        group = new Group<CostRankingEntry>({
          ...empty(),
          key,
          label: by === "model" ? f.usage.model : by === "bot" ? f.run.name : f.run.workspace_name,
          ...(by === "bot"
            ? { workspaceId: f.run.workspace_id, workspaceName: f.run.workspace_name }
            : {}),
        });
        groups.set(key, group);
      }
      group.add(f);
    }
    const entries = [...groups.values()].map((g) => g.finish());
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
