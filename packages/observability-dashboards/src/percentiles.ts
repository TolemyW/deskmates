// Percentiles for the focus dashboards (ADR-0046 amendment 2 decision 19). The nearest-rank
// method needs only `row_number()` and `count(*)` windows and integer arithmetic, which every SQL
// engine spells the same, so this is a query helper shared by every dialect, not a sixth macro:
// decision 7's five macros stay five. The p-th percentile of n values is the value at rank
// ceil(p * n / 100), written `(n * p + 99) / 100` in integer division.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`${what} must be a lower-case identifier: ${name}`);
  return name;
}

export interface PercentileSpec {
  /** A SELECT whose output has the `value` column and every `by` column. */
  from: string;
  /** The column whose percentiles are taken; NULLs are left out. */
  value: string;
  /** Group columns; one row per group. Empty: one row for the whole input, even when empty. */
  by?: readonly string[];
  /** Integer percentiles from 1 to 100; each becomes a column `p<p>`. */
  ps: readonly number[];
}

/**
 * A relation (use it in FROM or JOIN, parenthesized) with the `by` columns, `n` (the non-NULL
 * values counted) and one `p<p>` column per requested percentile. Its aliases start with `pct_`.
 */
export function percentiles({ from, value, by = [], ps }: PercentileSpec): string {
  identifier(value, "percentile value");
  const keys = by.map((key) => identifier(key, "percentile group column"));
  if (ps.length === 0) throw new Error("percentiles needs at least one percentile");
  for (const p of ps)
    if (!Number.isInteger(p) || p < 1 || p > 100)
      throw new Error(`a percentile is an integer from 1 to 100: ${p}`);
  const partition = keys.length ? `PARTITION BY ${keys.join(", ")} ` : "";
  const columns = ps.map(
    (p) => `max(CASE WHEN pct_rn = (pct_n * ${p} + 99) / 100 THEN ${value} END) AS p${p}`,
  );
  const group = keys.length ? ` GROUP BY ${keys.join(", ")}` : "";
  return [
    `SELECT ${[...keys, "count(*) AS n", ...columns].join(", ")} FROM (`,
    `SELECT ${[...keys, value].join(", ")}, row_number() OVER (${partition}ORDER BY ${value}) AS pct_rn,`,
    ` count(*) OVER (${partition.trim()}) AS pct_n`,
    ` FROM (${from}) pct_src WHERE ${value} IS NOT NULL) pct_ranked${group}`,
  ].join("");
}
