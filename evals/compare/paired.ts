// The paired difference and the two-condition verdict of measurement §4.3.
//
// Each task contributes one number per side (its pass rate over K runs, or its mean cost), and
// the estimate is the mean over tasks of candidate minus baseline. Runs of the same task are
// correlated, so the standard error is clustered by task: with one difference per cluster that is
// exactly sd(d) / sqrt(n), the CR1 cluster-robust error of a paired design. The 95% interval uses
// Student's t with n - 1 degrees of freedom.

import { normalCdf, normalQuantile, tQuantile } from "./distributions.js";

export type Verdict = "better" | "worse" | "no difference" | "inconclusive";

export interface PairedEstimate {
  /** Tasks paired. */
  n: number;
  /** Mean of candidate minus baseline. */
  estimate: number;
  se: number;
  lower: number;
  upper: number;
  /** Power to detect a difference of `delta` at this standard error (two-sided, α = 0.05). */
  power: number;
}

export function pairedEstimate(differences: readonly number[], delta: number): PairedEstimate {
  const n = differences.length;
  if (n === 0) {
    return { n, estimate: 0, se: Number.NaN, lower: Number.NaN, upper: Number.NaN, power: 0 };
  }
  const mean = differences.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? differences.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1) : Number.NaN;
  const se = Math.sqrt(variance / n);
  const crit = n > 1 ? tQuantile(0.975, n - 1) : Number.NaN;
  return {
    n,
    estimate: mean,
    se,
    lower: mean - crit * se,
    upper: mean + crit * se,
    power: powerAt(delta, se),
  };
}

/** Two-sided power at α = 0.05 to detect a true difference of `delta` with standard error `se`. */
export function powerAt(delta: number, se: number): number {
  if (!Number.isFinite(se)) return 0;
  if (se === 0) return 1;
  const z = normalQuantile(0.975);
  return normalCdf(delta / se - z) + normalCdf(-delta / se - z);
}

/**
 * Measurement §4.3, higher is better: better when the interval is above 0 and the estimate at
 * least `delta`; worse when the interval is below 0 and the estimate at most -`delta`; no
 * difference when the interval contains 0 with power ≥ 0.8; inconclusive otherwise.
 */
export function verdictOf(e: PairedEstimate, delta: number): Verdict {
  if (e.n < 2 || !Number.isFinite(e.se)) return "inconclusive";
  if (e.lower > 0 && e.estimate >= delta) return "better";
  if (e.upper < 0 && e.estimate <= -delta) return "worse";
  if (e.lower <= 0 && e.upper >= 0 && e.power >= 0.8) return "no difference";
  return "inconclusive";
}
