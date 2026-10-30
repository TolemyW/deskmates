// The predeclared size and cost of the web search comparison (protocol of 2026-10-18), computed
// from the task file with `evals/power.ts`. Nothing here runs: it prints what the campaign would
// cost and what it could detect, so the numbers in the protocol are reproducible.

import { type Ceiling, ceilingOf } from "../campaign/ceiling.js";
import { AUTHORISATION } from "../campaign/gate.js";
import type { DurationBucket } from "../compare/result-row.js";
import { type PowerReport, powerReport, runsNeeded } from "../power.js";
import { WEB_SEARCH_ARMS, WEB_SEARCH_COMPARISON } from "./arms.js";
import { type WebSearchTaskSet, activeItems } from "./task-set.js";

const BUCKETS: readonly DurationBucket[] = ["short", "medium", "long"];

export interface WebSearchPlan {
  version: string;
  k: number;
  baseline: number;
  delta: number;
  tasks: Record<DurationBucket | "total" | "holdout", number>;
  power: { scope: string; report: PowerReport }[];
  runsNeededPerArm: number;
  runsPerArm: number;
  /** The one ceiling of the whole campaign, both arms and every block (protocol amendment 1). */
  ceiling: Ceiling;
  /** The first batch (`smoke_tasks`) at K=1, run first in block 1, inside `ceiling`. */
  firstBatch: Ceiling;
}

export function webSearchPlan(set: WebSearchTaskSet): WebSearchPlan {
  const items = activeItems(set);
  const k = set.defaults.repeats;
  const baseline = set.defaults.planning_baseline;
  const delta = set.defaults.delta_pass_rate;
  const count = (bucket: DurationBucket) => items.filter((i) => i.bucket === bucket).length;
  const tasks = {
    total: items.length,
    short: count("short"),
    medium: count("medium"),
    long: count("long"),
    holdout: items.filter((i) => i.holdout).length,
  };
  const opts = { alpha: set.defaults.alpha, power: set.defaults.power };
  const power = (
    [
      ["all", tasks.total],
      ["short", tasks.short],
      ["medium", tasks.medium],
      ["long", tasks.long],
      ["holdout", tasks.holdout],
    ] as const
  ).map(([scope, n]) => ({ scope, report: powerReport(n, k, baseline, opts) }));
  const arms = WEB_SEARCH_ARMS.length;
  const cap = set.ceiling.per_run_usd;
  const smoke = items.filter((i) => set.ceiling.smoke_tasks.includes(i.id));
  return {
    version: set.version,
    k,
    baseline,
    delta,
    tasks,
    power,
    runsNeededPerArm: Math.ceil(runsNeeded(baseline, delta, opts)),
    runsPerArm: tasks.total * k,
    ceiling: ceilingOf(
      BUCKETS.map((bucket) => ({
        label: `${bucket}, ${tasks[bucket]} tasks × ${arms} arms × K=${k}`,
        runs: tasks[bucket] * arms * k,
        perRunUsd: cap[bucket],
      })),
    ),
    firstBatch: ceilingOf(
      BUCKETS.map((bucket) => {
        const n = smoke.filter((i) => i.bucket === bucket).length;
        return {
          label: `first batch ${bucket}, ${n} tasks × ${arms} arms × K=1`,
          runs: n * arms,
          perRunUsd: cap[bucket],
        };
      }),
    ),
  };
}

const pts = (x: number) => `${(x * 100).toFixed(1)} points`;
const usd = (x: number) => `USD ${x.toFixed(2)}`;

export function renderWebSearchPlan(plan: WebSearchPlan): string {
  const c = WEB_SEARCH_COMPARISON;
  const lines = [
    `Web search campaign ${plan.version} (ADR-0049 decision 13). Nothing has been run.`,
    `Arms: ${WEB_SEARCH_ARMS.map((a) => a.arm).join(", ")}. Comparison ${c.id}: ${c.candidate} vs ${c.baseline} (${c.knob}).`,
    `Tasks: ${plan.tasks.total} active (${plan.tasks.short} short, ${plan.tasks.medium} medium, ${plan.tasks.long} long; ${plan.tasks.holdout} held out), K=${plan.k}.`,
    `Planning baseline pass rate ${plan.baseline}, practical δ ${pts(plan.delta)}: ${plan.runsNeededPerArm} runs per arm needed, ${plan.runsPerArm} planned.`,
    "Minimum detectable effect (80% power, one-sided α = 0.05), optimistic / conservative:",
    ...plan.power.map(
      (p) =>
        `  ${p.scope}: ${pts(p.report.optimistic)} / ${pts(p.report.conservative)} (${p.report.tasks} tasks)`,
    ),
    `Ceiling, the whole campaign (both arms, every block): ${usd(plan.ceiling.totalUsd)}`,
    ...plan.ceiling.lines.map(
      (l) => `  ${l.label}: ${l.runs} runs × ${usd(l.perRunUsd)} = ${usd(l.usd)}`,
    ),
    `First batch, run first in block 1 and counted in the campaign: ${usd(plan.firstBatch.totalUsd)} of it`,
    ...plan.firstBatch.lines.map(
      (l) => `  ${l.label}: ${l.runs} runs × ${usd(l.perRunUsd)} = ${usd(l.usd)}`,
    ),
    "Searches cost nothing: the fixture is local and SearXNG has no unit price (ADR-0049 decision 11).",
    ...AUTHORISATION,
  ];
  return `${lines.join("\n")}\n`;
}
