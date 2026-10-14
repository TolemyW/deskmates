// Paired Hotelling T² on behavioral fingerprints (measurement §3.5): has the distribution of
// what the agent does moved, even where the pass rate has not? One vector per task, the
// candidate's mean fingerprint minus the baseline's; H0 is a zero mean difference.
//
//   T² = n · d̄ᵀ S⁻¹ d̄,   F = (n − p) / (p (n − 1)) · T²  ~  F(p, n − p)
//
// Dimensions that do not vary across tasks carry no information about S and are dropped (a
// constant non-zero shift is reported separately). Needs n > p after that.

import { fSurvival } from "./distributions.js";

export type HotellingResult =
  | {
      computable: true;
      n: number;
      dimensions: string[];
      t2: number;
      f: number;
      df1: number;
      df2: number;
      pValue: number;
      /** p < 0.05, or a dimension moved by the same non-zero amount on every task. */
      moved: boolean;
      /** Dimensions dropped because they did not vary; those with a non-zero constant shift. */
      constantShift: string[];
    }
  | { computable: false; reason: string; constantShift: string[] };

function invert(m: number[][]): number[][] | undefined {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r]?.[col] ?? 0) > Math.abs(a[pivot]?.[col] ?? 0)) pivot = r;
    }
    const pv = a[pivot]?.[col] ?? 0;
    if (Math.abs(pv) < 1e-12) return undefined;
    [a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
    const row = a[col] as number[];
    for (let j = 0; j < 2 * n; j += 1) row[j] = (row[j] ?? 0) / pv;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const other = a[r] as number[];
      const factor = other[col] ?? 0;
      for (let j = 0; j < 2 * n; j += 1) other[j] = (other[j] ?? 0) - factor * (row[j] ?? 0);
    }
  }
  return a.map((row) => row.slice(n));
}

export function pairedHotelling(
  differences: readonly Record<string, number>[],
  alpha = 0.05,
): HotellingResult {
  const n = differences.length;
  const names = [...new Set(differences.flatMap((d) => Object.keys(d)))].sort();
  const value = (d: Record<string, number>, k: string) => {
    const v = d[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const means = new Map(
    names.map((k) => [k, differences.reduce((a, d) => a + value(d, k), 0) / Math.max(n, 1)]),
  );
  const varying: string[] = [];
  const constantShift: string[] = [];
  for (const k of names) {
    const m = means.get(k) ?? 0;
    const varies = differences.some((d) => Math.abs(value(d, k) - m) > 1e-12);
    if (varies) varying.push(k);
    else if (Math.abs(m) > 1e-12) constantShift.push(k);
  }
  const p = varying.length;
  if (p === 0) {
    return n > 0 && constantShift.length === 0
      ? {
          computable: true,
          n,
          dimensions: [],
          t2: 0,
          f: 0,
          df1: 0,
          df2: n,
          pValue: 1,
          moved: false,
          constantShift,
        }
      : { computable: false, reason: "no varying fingerprint dimension", constantShift };
  }
  if (n <= p) {
    return {
      computable: false,
      reason: `needs more paired tasks (${n}) than varying fingerprint dimensions (${p})`,
      constantShift,
    };
  }
  const dbar = varying.map((k) => means.get(k) ?? 0);
  const s = varying.map((ki, i) =>
    varying.map(
      (kj, j) =>
        differences.reduce(
          (a, d) => a + (value(d, ki) - (dbar[i] ?? 0)) * (value(d, kj) - (dbar[j] ?? 0)),
          0,
        ) /
        (n - 1),
    ),
  );
  const inv = invert(s);
  if (inv === undefined) {
    return {
      computable: false,
      reason: "fingerprint covariance is singular (dimensions move together)",
      constantShift,
    };
  }
  let quad = 0;
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < p; j += 1) quad += (dbar[i] ?? 0) * (inv[i]?.[j] ?? 0) * (dbar[j] ?? 0);
  }
  const t2 = n * quad;
  const df1 = p;
  const df2 = n - p;
  const f = ((n - p) / (p * (n - 1))) * t2;
  const pValue = fSurvival(f, df1, df2);
  return {
    computable: true,
    n,
    dimensions: varying,
    t2,
    f,
    df1,
    df2,
    pValue,
    moved: pValue < alpha || constantShift.length > 0,
    constantShift,
  };
}
