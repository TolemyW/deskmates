// Operation receipts in the budget and the Costs page (ADR-0040 amendment A). `operation_requests`
// is the receipt of every look, asr or image generation call: priced once, when recorded
// (decision 8). A refused call never reached the service and counts nowhere but its own refusal
// count. An operation row is never estimated (decision 13, design D6): without a price it is
// unpriced, and its quantity stays in its own unit.

import type { CostOperationUsage, OperationUnit, RunId } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** A run's operation spend for the budget (decision 12). */
export interface OperationSpend {
  knownUsd: number;
  /** Forwarded calls whose quantity is unknown. */
  unmeasuredUsageCount: number;
  /** Forwarded calls with a quantity but no configured price. */
  unestimatedUsageCount: number;
}

export function operationSpend(db: GatewayDb, runId: RunId): OperationSpend {
  const row = db
    .prepare(
      `SELECT sum(cost_usd) AS known,
              sum(cost_usd IS NULL AND quantity IS NULL) AS unmeasured,
              sum(cost_usd IS NULL AND quantity IS NOT NULL) AS unestimated
         FROM operation_requests WHERE run_id = ? AND status <> 'refused'`,
    )
    .get(runId) as { known: number | null; unmeasured: number | null; unestimated: number | null };
  return {
    knownUsd: micro(row.known ?? 0),
    unmeasuredUsageCount: row.unmeasured ?? 0,
    unestimatedUsageCount: row.unestimated ?? 0,
  };
}

/** The grouped operation sums of one Costs group (decision 14). */
export interface OperationSumRow {
  /** Distinct runs of the group with an operation. */
  op_runs: number;
  /** Of those, runs with no model usage in the group: the model sums did not count them. */
  op_extra_runs: number;
  op_count: number;
  op_priced: number;
  op_unpriced: number;
  op_unestimated: number;
  op_known: number | null;
}

/**
 * The aggregate columns over `operation_requests o` of forwarded calls. The one placeholder (the
 * model filter, when `model` is true) belongs to the subquery that tells operations-only runs.
 */
export function operationSums(model: boolean): string {
  const modelClause = model ? " AND m2.model = ?" : "";
  return `count(DISTINCT o.run_id) AS op_runs,
    count(DISTINCT CASE WHEN NOT EXISTS (
        SELECT 1 FROM run_usage_summary_models m2 WHERE m2.run_id = o.run_id${modelClause}
      ) THEN o.run_id END) AS op_extra_runs,
    count(*) AS op_count,
    sum(o.cost_usd IS NOT NULL) AS op_priced,
    sum(o.cost_usd IS NULL) AS op_unpriced,
    sum(o.cost_usd IS NULL AND o.quantity IS NOT NULL) AS op_unestimated,
    sum(o.cost_usd) AS op_known`;
}

/** The model-usage sums `costs.ts` groups, as far as operations add to them. */
export interface MoneySums {
  run_count: number;
  usage_count: number;
  priced_usage_count: number;
  unpriced_usage_count: number;
  unestimated_usage_count: number;
  known_cost_usd: number | null;
}

/**
 * Add a group's operation sums to its model sums: calls, priced and unpriced rows, unestimated
 * rows and known cost. Tokens are left alone; nothing changes when the group has no operation.
 */
export function addOperationSums<T extends MoneySums>(
  sums: T,
  ops: OperationSumRow | undefined,
): T {
  if (!ops || !ops.op_count) return sums;
  sums.run_count = (sums.run_count ?? 0) + ops.op_extra_runs;
  sums.usage_count = (sums.usage_count ?? 0) + ops.op_count;
  sums.priced_usage_count = (sums.priced_usage_count ?? 0) + ops.op_priced;
  sums.unpriced_usage_count = (sums.unpriced_usage_count ?? 0) + ops.op_unpriced;
  sums.unestimated_usage_count = (sums.unestimated_usage_count ?? 0) + ops.op_unestimated;
  if (ops.op_known !== null) sums.known_cost_usd = (sums.known_cost_usd ?? 0) + ops.op_known;
  return sums;
}

/** Per-unit usage of the operations in a run filter (`FROM runs r ... WHERE ...`), or nothing. */
export function operationUsage(
  db: GatewayDb,
  filterSql: string,
  params: readonly unknown[],
  model: string | undefined,
): CostOperationUsage | undefined {
  const from = filterSql.replace("WHERE", "JOIN operation_requests o ON o.run_id = r.id WHERE");
  const modelClause = model ? " AND o.model = ?" : "";
  const all = model ? [...params, model] : [...params];
  const units = db
    .prepare(
      `SELECT o.unit AS unit, count(*) AS callCount, coalesce(sum(o.quantity), 0) AS quantity,
              sum(o.quantity IS NULL) AS unmeasuredCount
         ${from}${modelClause} AND o.status <> 'refused'
        GROUP BY o.unit ORDER BY o.unit`,
    )
    .all(...all) as {
    unit: OperationUnit;
    callCount: number;
    quantity: number;
    unmeasuredCount: number;
  }[];
  const refused = db
    .prepare(`SELECT count(*) AS n ${from}${modelClause} AND o.status = 'refused'`)
    .get(...all) as { n: number };
  if (units.length === 0 && refused.n === 0) return undefined;
  return {
    units: units.map((u) => ({ ...u, quantity: micro(u.quantity) })),
    refusedCount: refused.n,
  };
}
