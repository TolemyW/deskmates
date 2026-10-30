// The predeclared size and cost of the retrieval campaign (protocol of 2026-10-17, comparison R),
// computed from the task file with `evals/power.ts`. Nothing here runs: it prints what a campaign
// would cost and what it could detect, so the numbers in the protocol are reproducible.

import { type Ceiling, ceilingOf } from "../campaign/ceiling.js";
import { AUTHORISATION } from "../campaign/gate.js";
import { type PowerReport, powerReport, runsNeeded } from "../power.js";
import { RETRIEVAL_ARMS, RETRIEVAL_COMPARISONS } from "./arms.js";
import { type RetrievalTaskSet, activeItems } from "./task-set.js";

export interface RetrievalPlan {
  version: string;
  k: number;
  baseline: number;
  delta: number;
  tasks: {
    total: number;
    short: number;
    medium: number;
    knowledge: number;
    memory: number;
    holdout: number;
  };
  power: { scope: string; report: PowerReport }[];
  /** Runs per arm needed for `delta` at `baseline` (§4.4 formula), against what the plan has. */
  runsNeededPerArm: number;
  runsPerArm: number;
  /** The one ceiling of the whole campaign, every arm and block (protocol amendment 1). */
  ceiling: Ceiling;
  /** The first batch (the task file's `smoke_tasks`) at K=1: run first in block 1, inside `ceiling`. */
  firstBatch: Ceiling;
}

export function retrievalPlan(set: RetrievalTaskSet): RetrievalPlan {
  const items = activeItems(set);
  const k = set.defaults.repeats;
  const baseline = set.defaults.planning_baseline;
  const delta = set.defaults.delta_pass_rate;
  const count = (f: (i: (typeof items)[number]) => boolean) => items.filter(f).length;
  const tasks = {
    total: items.length,
    short: count((i) => i.bucket === "short"),
    medium: count((i) => i.bucket === "medium"),
    knowledge: count((i) => i.corpus === "knowledge"),
    memory: count((i) => i.corpus === "memory"),
    holdout: count((i) => i.holdout),
  };
  const opts = { alpha: set.defaults.alpha, power: set.defaults.power };
  const power = (
    [
      ["all", tasks.total],
      ["short", tasks.short],
      ["medium", tasks.medium],
      ["knowledge", tasks.knowledge],
      ["memory", tasks.memory],
    ] as const
  ).map(([scope, n]) => ({ scope, report: powerReport(n, k, baseline, opts) }));
  const arms = RETRIEVAL_ARMS.length;
  const cap = set.ceiling.per_run_usd;
  const smokeItems = items.filter((i) => set.ceiling.smoke_tasks.includes(i.id));
  const smokeShort = smokeItems.filter((i) => i.bucket === "short").length;
  const smokeMedium = smokeItems.length - smokeShort;
  return {
    version: set.version,
    k,
    baseline,
    delta,
    tasks,
    power,
    runsNeededPerArm: Math.ceil(runsNeeded(baseline, delta, opts)),
    runsPerArm: tasks.total * k,
    firstBatch: ceilingOf([
      {
        label: `first batch short, ${smokeShort} tasks × ${arms} arms × K=1`,
        runs: smokeShort * arms,
        perRunUsd: cap.short,
      },
      {
        label: `first batch medium, ${smokeMedium} tasks × ${arms} arms × K=1`,
        runs: smokeMedium * arms,
        perRunUsd: cap.medium,
      },
    ]),
    ceiling: ceilingOf([
      {
        label: `short, ${tasks.short} tasks × ${arms} arms × K=${k}`,
        runs: tasks.short * arms * k,
        perRunUsd: cap.short,
      },
      {
        label: `medium, ${tasks.medium} tasks × ${arms} arms × K=${k}`,
        runs: tasks.medium * arms * k,
        perRunUsd: cap.medium,
      },
    ]),
  };
}

const pts = (x: number) => `${(x * 100).toFixed(1)} points`;
const usd = (x: number) => `USD ${x.toFixed(2)}`;

export function renderRetrievalPlan(plan: RetrievalPlan): string {
  const lines = [
    `Retrieval campaign ${plan.version} (ADR-0041 decision 10). Nothing has been run.`,
    `Arms: ${RETRIEVAL_ARMS.map((a) => a.arm).join(", ")}. Comparisons: ${RETRIEVAL_COMPARISONS.map((c) => `${c.id} ${c.candidate} vs ${c.baseline} (${c.knob})`).join("; ")}.`,
    `Tasks: ${plan.tasks.total} active (${plan.tasks.short} short, ${plan.tasks.medium} medium; ${plan.tasks.knowledge} knowledge, ${plan.tasks.memory} memory; ${plan.tasks.holdout} held out), K=${plan.k}.`,
    `Planning baseline pass rate ${plan.baseline}, practical δ ${pts(plan.delta)}: ${plan.runsNeededPerArm} runs per arm needed, ${plan.runsPerArm} planned.`,
    "Minimum detectable effect (80% power, one-sided α = 0.05), optimistic / conservative:",
    ...plan.power.map(
      (p) =>
        `  ${p.scope}: ${pts(p.report.optimistic)} / ${pts(p.report.conservative)} (${p.report.tasks} tasks)`,
    ),
    `Ceiling, the whole campaign (every arm and block): ${usd(plan.ceiling.totalUsd)}`,
    ...plan.ceiling.lines.map(
      (l) => `  ${l.label}: ${l.runs} runs × ${usd(l.perRunUsd)} = ${usd(l.usd)}`,
    ),
    `First batch, run first in block 1 and counted in the campaign: ${usd(plan.firstBatch.totalUsd)} of it`,
    ...plan.firstBatch.lines.map(
      (l) => `  ${l.label}: ${l.runs} runs × ${usd(l.perRunUsd)} = ${usd(l.usd)}`,
    ),
    "Embedding and rerank calls are priced as known zero (ADR-0041 decision 8) and are not in the ceiling.",
    ...AUTHORISATION,
  ];
  return `${lines.join("\n")}\n`;
}
