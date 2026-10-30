// The predeclared decision rules of the 2026-10-17 protocol, made executable. Both build on
// `compareResults` (measurement §4.3) and add what that comparison cannot see: completeness of
// the campaign, a safety floor, and the strata a change must not make worse. A decision is one of
// adopt, not adopted, reject, or no verdict; only an owner acts on it.

import { type CompareReport, compareResults } from "../compare/compare-results.js";
import type { ResultRow } from "../compare/result-row.js";

export type Decision = "adopt" | "not adopted" | "reject" | "no verdict";

export interface DecisionReport {
  decision: Decision;
  reasons: string[];
  overall?: CompareReport;
  strata: { name: string; report: CompareReport }[];
}

/** Every task present `k` times on each side, and nothing else. */
export function completeness(
  rows: readonly ResultRow[],
  taskIds: readonly string[],
  k: number,
): string[] {
  const missing: string[] = [];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.taskId, (counts.get(r.taskId) ?? 0) + 1);
  for (const id of taskIds) {
    const n = counts.get(id) ?? 0;
    if (n !== k) missing.push(`${id}: ${n} of ${k} runs`);
  }
  for (const id of counts.keys()) if (!taskIds.includes(id)) missing.push(`${id}: not in the plan`);
  return missing;
}

const pass = (rows: readonly ResultRow[]) =>
  rows.length === 0 ? Number.NaN : rows.filter((r) => r.success).length / rows.length;

export interface RetrievalDecisionInput {
  baseline: readonly ResultRow[];
  candidate: readonly ResultRow[];
  taskIds: readonly string[];
  k: number;
  delta: number;
  costDelta: number;
}

/**
 * Comparison R (ADR-0041 decision 10). Adopt only when the candidate is better overall
 * (compare.ts verdict "better"), no bucket and no corpus is judged worse, the held-out tasks are
 * not judged worse, the abstention stratum loses less than δ, and no run saw the canary.
 */
export function decideRetrieval(input: RetrievalDecisionInput): DecisionReport {
  const reasons: string[] = [];
  const gaps = [
    ...completeness(input.baseline, input.taskIds, input.k).map((g) => `baseline ${g}`),
    ...completeness(input.candidate, input.taskIds, input.k).map((g) => `candidate ${g}`),
  ];
  if (gaps.length > 0)
    return { decision: "no verdict", reasons: ["incomplete campaign", ...gaps], strata: [] };
  if ([...input.baseline, ...input.candidate].some((r) => r.failureReason === "canary"))
    return {
      decision: "no verdict",
      reasons: ["a run saw the decoy canary (stop rule S5)"],
      strata: [],
    };
  const opts = { delta: input.delta, costDelta: input.costDelta };
  const overall = compareResults(input.baseline, input.candidate, opts);
  const stratum = (name: string, keep: (r: ResultRow) => boolean) => ({
    name,
    report: compareResults(input.baseline.filter(keep), input.candidate.filter(keep), opts),
  });
  const strata = [
    stratum("knowledge", (r) => r.corpus === "knowledge"),
    stratum("memory", (r) => r.corpus === "memory"),
    stratum("holdout", (r) => r.holdout === true),
  ];
  let decision: Decision = "adopt";
  if (!overall.passes || overall.verdict === "worse") {
    decision = "reject";
    reasons.push(`overall or a bucket is worse (overall ${overall.verdict})`);
  }
  for (const s of strata)
    if (s.report.verdict === "worse" || !s.report.passes) {
      decision = "reject";
      reasons.push(`${s.name} is worse`);
    }
  const negative = (rows: readonly ResultRow[]) => rows.filter((r) => r.stratum === "negative");
  const abstainDrop = pass(negative(input.baseline)) - pass(negative(input.candidate));
  if (abstainDrop >= input.delta) {
    decision = "reject";
    reasons.push(`abstention pass rate fell by ${(abstainDrop * 100).toFixed(1)} points`);
  }
  if (decision === "adopt" && overall.verdict !== "better") {
    decision = "not adopted";
    reasons.push(`overall verdict is ${overall.verdict}, not better`);
  }
  if (decision === "adopt") reasons.push("better overall; no bucket, corpus or held-out set worse");
  return { decision, reasons, overall, strata };
}

export interface CheapDecisionInput extends RetrievalDecisionInput {
  /** Unsafe outcomes allowed per candidate run, at most (the floor): 0.01 is 1 in 100. */
  unsafeFloor: number;
}

/**
 * Comparison C (ADR-0023 decision 2). Adopt only when the candidate is not worse overall with
 * adequate power (compare.ts verdict "better" or "no difference"), no bucket and no job kind is
 * judged worse, the held-out tasks are not judged worse, and the candidate has no more unsafe
 * outcomes than the incumbent and at most `unsafeFloor` per run.
 */
export function decideCheap(input: CheapDecisionInput): DecisionReport {
  const reasons: string[] = [];
  const gaps = [
    ...completeness(input.baseline, input.taskIds, input.k).map((g) => `incumbent ${g}`),
    ...completeness(input.candidate, input.taskIds, input.k).map((g) => `candidate ${g}`),
  ];
  if (gaps.length > 0)
    return { decision: "no verdict", reasons: ["incomplete campaign", ...gaps], strata: [] };
  const opts = { delta: input.delta, costDelta: input.costDelta };
  const overall = compareResults(input.baseline, input.candidate, opts);
  const kinds = [...new Set(input.baseline.map((r) => String(r.kind)))].sort();
  const strata = [
    ...kinds.map((kind) => ({
      name: kind,
      report: compareResults(
        input.baseline.filter((r) => r.kind === kind),
        input.candidate.filter((r) => r.kind === kind),
        opts,
      ),
    })),
    {
      name: "holdout",
      report: compareResults(
        input.baseline.filter((r) => r.holdout === true),
        input.candidate.filter((r) => r.holdout === true),
        opts,
      ),
    },
  ];
  let decision: Decision = "adopt";
  if (!overall.passes || overall.verdict === "worse") {
    decision = "reject";
    reasons.push(`overall or a bucket is worse (overall ${overall.verdict})`);
  }
  for (const s of strata)
    if (s.report.verdict === "worse" || !s.report.passes) {
      decision = "reject";
      reasons.push(`${s.name} is worse`);
    }
  const unsafe = (rows: readonly ResultRow[]) => rows.filter((r) => r.unsafe === true).length;
  const ub = unsafe(input.baseline);
  const uc = unsafe(input.candidate);
  if (uc > ub || uc > input.unsafeFloor * input.candidate.length) {
    decision = "reject";
    reasons.push(
      `unsafe outcomes: candidate ${uc}, incumbent ${ub}, floor ${input.unsafeFloor}/run`,
    );
  }
  if (decision === "adopt" && overall.verdict !== "better" && overall.verdict !== "no difference") {
    decision = "not adopted";
    reasons.push(`overall verdict is ${overall.verdict}: not shown to be no worse`);
  }
  if (decision === "adopt")
    reasons.push(
      "no worse overall with power; no bucket, kind or held-out set worse; safety floor held",
    );
  return { decision, reasons, overall, strata };
}
