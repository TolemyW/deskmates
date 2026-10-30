// The predeclared size and cost of the cheap-model campaign (protocol of 2026-10-17, comparison
// C), computed from the task file with `evals/power.ts`. Nothing here runs.

import { type Ceiling, ceilingOf } from "../campaign/ceiling.js";
import { AUTHORISATION } from "../campaign/gate.js";
import { type PowerReport, powerReport } from "../power.js";
import { CHEAP_ARMS } from "./arms.js";
import { CHEAP_JOB_KINDS, type CheapTaskSet, cheapTasks } from "./task-set.js";

export interface CheapPlan {
  version: string;
  k: number;
  baseline: number;
  tasks: { total: number; short: number; medium: number; holdout: number };
  power: { scope: string; report: PowerReport }[];
  runsPerArm: number;
  /** The one ceiling of the whole campaign, both arms and every block (protocol amendment 1). */
  ceiling: Ceiling;
  /** The first batch (the task file's `smoke_cases`) at K=1: run first in block 1, inside `ceiling`. */
  firstBatch: Ceiling;
}

export function cheapPlan(set: CheapTaskSet): CheapPlan {
  const tasks = cheapTasks(set);
  const k = set.defaults.repeats;
  const baseline = set.defaults.planning_baseline;
  const opts = { alpha: set.defaults.alpha, power: set.defaults.power };
  const power = [
    { scope: "all", report: powerReport(tasks.length, k, baseline, opts) },
    ...(["short", "medium"] as const).map((b) => ({
      scope: b,
      report: powerReport(tasks.filter((t) => t.bucket === b).length, k, baseline, opts),
    })),
    ...CHEAP_JOB_KINDS.map((kind) => ({
      scope: kind,
      report: powerReport(tasks.filter((t) => t.kind === kind).length, k, baseline, opts),
    })),
  ];
  const cap = set.ceiling.per_run_usd;
  // The candidate's runs are priced too: a ceiling does not assume the candidate is free. A
  // triage case also starts worker runs on the main model; they are stopped and capped per case.
  const arms = CHEAP_ARMS.length;
  const lines = (list: typeof tasks, repeats: number, label: string) => [
    ...CHEAP_JOB_KINDS.map((kind) => {
      const n = list.filter((t) => t.kind === kind).length;
      return {
        label: `${label} ${kind}, ${n} tasks × ${arms} arms × K=${repeats}`,
        runs: n * arms * repeats,
        perRunUsd: cap[kind],
      };
    }),
    {
      label: `${label} triage worker leak, ${list.filter((t) => t.kind === "round_triage").length} tasks × ${arms} arms × K=${repeats}`,
      runs: list.filter((t) => t.kind === "round_triage").length * arms * repeats,
      perRunUsd: set.ceiling.triage_leak_usd,
    },
  ];
  const smoke = tasks.filter((t) => set.ceiling.smoke_cases.includes(t.caseId));
  return {
    version: set.version,
    k,
    baseline,
    tasks: {
      total: tasks.length,
      short: tasks.filter((t) => t.bucket === "short").length,
      medium: tasks.filter((t) => t.bucket === "medium").length,
      holdout: tasks.filter((t) => t.holdout).length,
    },
    power,
    runsPerArm: tasks.length * k,
    ceiling: ceilingOf(lines(tasks, k, "")),
    firstBatch: ceilingOf(lines(smoke, 1, "first batch")),
  };
}

const pts = (x: number) => `${(x * 100).toFixed(1)} points`;
const usd = (x: number) => `USD ${x.toFixed(2)}`;

export function renderCheapPlan(plan: CheapPlan): string {
  return `${[
    `Cheap-model campaign ${plan.version} (ADR-0023 decision 2). Nothing has been run.`,
    `Arms: ${CHEAP_ARMS.map((a) => `${a.arm} (CHEAP_MODEL from ${a.modelVar})`).join(", ")}.`,
    `Tasks: ${plan.tasks.total} active (${plan.tasks.short} small, ${plan.tasks.medium} large; ${plan.tasks.holdout} held out), K=${plan.k}, ${plan.runsPerArm} runs per arm.`,
    `Minimum detectable effect at planning baseline ${plan.baseline} (80% power, one-sided α = 0.05), optimistic / conservative:`,
    ...plan.power.map(
      (p) =>
        `  ${p.scope}: ${pts(p.report.optimistic)} / ${pts(p.report.conservative)} (${p.report.tasks} tasks)`,
    ),
    `Ceiling, the whole campaign (both arms, every block): ${usd(plan.ceiling.totalUsd)}`,
    ...plan.ceiling.lines.map(
      (l) => `  ${l.label.trim()}: ${l.runs} runs × ${usd(l.perRunUsd)} = ${usd(l.usd)}`,
    ),
    `First batch, run first in block 1 and counted in the campaign: ${usd(plan.firstBatch.totalUsd)} of it`,
    ...plan.firstBatch.lines
      .filter((l) => l.runs > 0)
      .map((l) => `  ${l.label.trim()}: ${l.runs} runs × ${usd(l.perRunUsd)} = ${usd(l.usd)}`),
    ...AUTHORISATION,
  ].join("\n")}\n`;
}
