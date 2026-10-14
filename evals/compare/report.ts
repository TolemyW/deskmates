// Markdown rendering of a `CompareReport`. The first line is always the minimum detectable
// effect and the second records whether long tasks participate in the verdict.

import { renderPowerLine } from "../power.js";
import type { CompareReport, ScopeComparison } from "./compare-results.js";

const pts = (x: number) =>
  Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}` : "n/a";
const pc = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

function row(s: ScopeComparison): string {
  const d = s.difference;
  return `| ${s.scope} | ${d.n} | ${pc(s.baselinePassRate)} | ${pc(s.candidatePassRate)} | ${pts(d.estimate)} | [${pts(d.lower)}, ${pts(d.upper)}] | ${Number.isFinite(d.power) ? d.power.toFixed(2) : "n/a"} | ${s.verdict} |`;
}

export function renderCompareReport(
  r: CompareReport,
  names: { baseline: string; candidate: string },
): string {
  const lines = [
    renderPowerLine(r.power),
    r.includesLong
      ? "Verdict includes short, medium and long buckets; power and confidence intervals remain reported per bucket."
      : "Long-task regression is not measured: the long bucket is a smoke set, reported per task only.",
    "",
    `# Paired comparison: ${names.candidate} against ${names.baseline}`,
    "",
    `Paired verdict tasks: ${r.pairedTasks}. Baseline only: ${r.baselineOnly.join(", ") || "none"}. Candidate only: ${r.candidateOnly.join(", ") || "none"}.`,
    "",
    `Pass rate, candidate minus baseline, in points; 95% interval with the standard error clustered by task; δ = ${(r.deltas.passRate * 100).toFixed(1)} points:`,
    "",
    "| scope | tasks | baseline | candidate | difference | 95% CI | power at δ | verdict |",
    "| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |",
    row(r.overall),
    ...r.buckets.map(row),
    "",
  ];
  const f = r.fingerprint;
  if (f.computable) {
    lines.push(
      `Fingerprint (paired Hotelling T² over ${f.dimensions.length} dimensions, ${f.n} tasks): T² = ${f.t2.toFixed(3)}, F(${f.df1}, ${f.df2}) = ${f.f.toFixed(3)}, p = ${f.pValue.toPrecision(3)}: ${f.movedAny ? "moved" : "not moved"}.`,
    );
  } else {
    lines.push(
      `Fingerprint: not computable (${f.reason}).${f.movedAny ? " Moved: a constant shift." : ""}`,
    );
  }
  if (f.constantShift.length > 0) {
    lines.push(`Constant shift on every task: ${f.constantShift.join(", ")}.`);
  }
  if (r.cost) {
    const c = r.cost.relative;
    lines.push(
      `Cost: ${pts(c.estimate)}% per task relative to the baseline mean ($${r.cost.baselineMeanUsd.toFixed(4)} → $${r.cost.candidateMeanUsd.toFixed(4)}), 95% CI [${pts(c.lower)}%, ${pts(c.upper)}%] over ${r.cost.tasks} tasks: ${r.cost.verdict} (cheaper is better, δ = ${pc(r.deltas.cost)}).`,
    );
  } else {
    lines.push("Cost: unknown (no task has a known cost on both sides).");
  }
  if (r.longTasks.length > 0) {
    lines.push(
      "",
      r.includesLong
        ? "Long tasks (included in the verdict):"
        : "Long tasks (smoke set, not in the verdict):",
      ...r.longTasks.map((t) => `- ${t.taskId}: baseline ${t.baseline}, candidate ${t.candidate}`),
    );
  }
  lines.push(
    "",
    `Verdict: ${r.verdict}${r.note ? ` (${r.note})` : ""}. ${r.passes ? "Passes: neither the total nor any bucket is worse." : "Does not pass: the total or a bucket is worse."}`,
  );
  return `${lines.join("\n")}\n`;
}
