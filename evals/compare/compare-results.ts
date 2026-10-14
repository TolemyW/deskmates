// The paired comparison of two result files (measurement §4.3): baseline A, candidate B.
//
// - Pairing unit: the task. Each task's pass rate over its K runs, candidate minus baseline;
//   tasks present on one side only are listed and left out.
// - Verdict scope defaults to short and medium (the old task set's long smoke cases).
//   An explicitly predeclared campaign can also include long; every included bucket gates it.
// - A change passes only when neither the total nor any bucket is judged worse (Principle 5).
// - Fingerprints: paired Hotelling T² on per-task mean fingerprints.
// - Cost: per-task mean cost, candidate minus baseline, relative to the baseline's mean cost,
//   judged with δ = 15% where cheaper is better. Runs with unknown cost are left out; a task
//   with no known cost on either side is not in the cost comparison.
// - When the pass rate shows no difference and the fingerprint moved: "cheaper" if cost is
//   judged better, otherwise "behavioral drift, a human must read the trajectories".

import { type PowerReport, powerReport } from "../power.js";
import { type HotellingResult, pairedHotelling } from "./hotelling.js";
import { type PairedEstimate, type Verdict, pairedEstimate, verdictOf } from "./paired.js";
import type { DurationBucket, ResultRow } from "./result-row.js";

export const DEFAULT_PASS_DELTA = 0.1;
export const DEFAULT_COST_DELTA = 0.15;
const VERDICT_BUCKETS: readonly DurationBucket[] = ["short", "medium"];

export interface CompareOptions {
  delta?: number;
  costDelta?: number;
  /** Opt in only for a campaign whose preregistered verdict covers long tasks. */
  includeLong?: boolean;
}

export interface ScopeComparison {
  scope: "all" | DurationBucket;
  baselinePassRate: number;
  candidatePassRate: number;
  difference: PairedEstimate;
  verdict: Verdict;
}

export interface CostComparison {
  tasks: number;
  baselineMeanUsd: number;
  candidateMeanUsd: number;
  /** Candidate minus baseline, as a fraction of the baseline's mean cost; negative is cheaper. */
  relative: PairedEstimate;
  /** Cheaper is better. */
  verdict: Verdict;
}

export interface CompareReport {
  includesLong: boolean;
  power: PowerReport;
  /** The practical thresholds the verdicts used: pass rate as a fraction, cost as a fraction. */
  deltas: { passRate: number; cost: number };
  pairedTasks: number;
  baselineOnly: string[];
  candidateOnly: string[];
  overall: ScopeComparison;
  buckets: ScopeComparison[];
  longTasks: { taskId: string; baseline: string; candidate: string }[];
  fingerprint: HotellingResult & { movedAny: boolean };
  cost: CostComparison | undefined;
  /** The pass-rate verdict over the explicitly selected duration buckets. */
  verdict: Verdict;
  /** False when the total or any bucket is judged worse. */
  passes: boolean;
  note?: "cheaper" | "behavioral drift, a human must read the trajectories";
}

interface TaskSummary {
  taskId: string;
  bucket: DurationBucket;
  runs: number;
  passes: number;
  fingerprint: Record<string, number>;
  costMean: number | undefined;
}

function summarise(rows: readonly ResultRow[]): Map<string, TaskSummary> {
  const byTask = new Map<string, ResultRow[]>();
  for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const out = new Map<string, TaskSummary>();
  for (const [taskId, runs] of byTask) {
    const bucket = runs[0]?.bucket as DurationBucket;
    if (runs.some((r) => r.bucket !== bucket)) {
      throw new Error(`task ${taskId} has runs in more than one bucket`);
    }
    const fp: Record<string, number> = {};
    const withFp = runs.filter((r) => r.fingerprint !== undefined);
    for (const r of withFp) {
      for (const [k, v] of Object.entries(r.fingerprint ?? {})) {
        if (typeof v === "number" && Number.isFinite(v)) fp[k] = (fp[k] ?? 0) + v / withFp.length;
      }
    }
    const costs = runs.flatMap((r) =>
      typeof r.costUsd === "number" && Number.isFinite(r.costUsd) ? [r.costUsd] : [],
    );
    out.set(taskId, {
      taskId,
      bucket,
      runs: runs.length,
      passes: runs.filter((r) => r.success).length,
      fingerprint: fp,
      costMean: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined,
    });
  }
  return out;
}

const rate = (t: TaskSummary) => t.passes / t.runs;
const mean = (xs: readonly number[]) =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

function scope(
  name: ScopeComparison["scope"],
  pairs: readonly [TaskSummary, TaskSummary][],
  delta: number,
): ScopeComparison {
  const difference = pairedEstimate(
    pairs.map(([a, b]) => rate(b) - rate(a)),
    delta,
  );
  return {
    scope: name,
    baselinePassRate: mean(pairs.map(([a]) => rate(a))),
    candidatePassRate: mean(pairs.map(([, b]) => rate(b))),
    difference,
    verdict: verdictOf(difference, delta),
  };
}

function flip(v: Verdict): Verdict {
  return v === "better" ? "worse" : v === "worse" ? "better" : v;
}

export function compareResults(
  baseline: readonly ResultRow[],
  candidate: readonly ResultRow[],
  opts: CompareOptions = {},
): CompareReport {
  const delta = opts.delta ?? DEFAULT_PASS_DELTA;
  const costDelta = opts.costDelta ?? DEFAULT_COST_DELTA;
  const includesLong = opts.includeLong === true;
  const verdictBuckets: readonly DurationBucket[] = includesLong
    ? [...VERDICT_BUCKETS, "long"]
    : VERDICT_BUCKETS;
  const a = summarise(baseline);
  const b = summarise(candidate);
  const baselineOnly = [...a.keys()].filter((k) => !b.has(k)).sort();
  const candidateOnly = [...b.keys()].filter((k) => !a.has(k)).sort();
  const pairs: [TaskSummary, TaskSummary][] = [];
  for (const [id, ta] of a) {
    const tb = b.get(id);
    if (tb === undefined) continue;
    if (ta.bucket !== tb.bucket) throw new Error(`task ${id} is ${ta.bucket} in one file only`);
    pairs.push([ta, tb]);
  }
  pairs.sort(([x], [y]) => (x.taskId < y.taskId ? -1 : 1));
  const verdictPairs = pairs.filter(([t]) => verdictBuckets.includes(t.bucket));

  const overall = scope("all", verdictPairs, delta);
  const buckets = verdictBuckets
    .map((bucket) =>
      scope(
        bucket,
        verdictPairs.filter(([t]) => t.bucket === bucket),
        delta,
      ),
    )
    .filter((s) => s.difference.n > 0);

  const k = Math.min(
    ...verdictPairs.flatMap(([x, y]) => [x.runs, y.runs]),
    Number.POSITIVE_INFINITY,
  );
  const baselineRate = overall.baselinePassRate;
  const power = powerReport(
    verdictPairs.length,
    Number.isFinite(k) ? k : 0,
    Number.isFinite(baselineRate) ? Math.min(Math.max(baselineRate, 0.01), 0.99) : 0.8,
  );

  const hotelling = pairedHotelling(
    verdictPairs.map(([x, y]) => {
      const d: Record<string, number> = {};
      for (const key of new Set([...Object.keys(x.fingerprint), ...Object.keys(y.fingerprint)])) {
        d[key] = (y.fingerprint[key] ?? 0) - (x.fingerprint[key] ?? 0);
      }
      return d;
    }),
  );
  const movedAny = hotelling.computable ? hotelling.moved : hotelling.constantShift.length > 0;

  const costPairs = verdictPairs.filter(
    ([x, y]) => x.costMean !== undefined && y.costMean !== undefined,
  );
  let cost: CostComparison | undefined;
  if (costPairs.length > 0) {
    const baseMean = mean(costPairs.map(([x]) => x.costMean ?? 0));
    const candMean = mean(costPairs.map(([, y]) => y.costMean ?? 0));
    if (baseMean > 0) {
      const relative = pairedEstimate(
        costPairs.map(([x, y]) => ((y.costMean ?? 0) - (x.costMean ?? 0)) / baseMean),
        costDelta,
      );
      cost = {
        tasks: costPairs.length,
        baselineMeanUsd: baseMean,
        candidateMeanUsd: candMean,
        relative,
        verdict: flip(verdictOf(relative, costDelta)),
      };
    }
  }

  const passes = overall.verdict !== "worse" && buckets.every((s) => s.verdict !== "worse");
  const report: CompareReport = {
    includesLong,
    power,
    deltas: { passRate: delta, cost: costDelta },
    pairedTasks: verdictPairs.length,
    baselineOnly,
    candidateOnly,
    overall,
    buckets,
    longTasks: pairs
      .filter(([t]) => t.bucket === "long")
      .map(([x, y]) => ({
        taskId: x.taskId,
        baseline: `${x.passes}/${x.runs}`,
        candidate: `${y.passes}/${y.runs}`,
      })),
    fingerprint: { ...hotelling, movedAny },
    cost,
    verdict: overall.verdict,
    passes,
  };
  if (overall.verdict === "no difference" && movedAny) {
    report.note =
      cost?.verdict === "better"
        ? "cheaper"
        : "behavioral drift, a human must read the trajectories";
  }
  return report;
}
