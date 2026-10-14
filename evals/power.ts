#!/usr/bin/env node
// Minimum detectable effect of a paired pass-rate comparison (measurement §4.4). Every compare
// report starts with this number, so that "not detected" is not read as "no difference".
//
//   npm run power -- [--tasks 44] [--k 5] [--baseline 0.8] [--power 0.8] [--alpha 0.05]
//
// AgentAssay's formula, one-sided α and power as in §4.4, for a drop from p_b to p_c = p_b − δ:
//
//   n = (z_{1−α} + z_{power})² · [p_b(1 − p_b) + p_c(1 − p_c)] / δ²
//
// n counts runs. K runs of one task are correlated, so the effective sample lies between the task
// count and the run count: the MDE at n = tasks × K is the optimistic figure the defaults are
// quoted at (44 × 5 detects 10 points), the MDE at n = tasks the conservative bound. Pairing moves
// the truth towards the optimistic end when A and B find the same tasks hard (§4.4, last
// paragraph); only the paired data can say how far.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalQuantile } from "./compare/distributions.js";

export interface PowerOptions {
  alpha?: number;
  power?: number;
}

/** Runs per version needed to detect a drop of `delta` from `baseline` (§4.4 formula). */
export function runsNeeded(baseline: number, delta: number, opts: PowerOptions = {}): number {
  const z = normalQuantile(1 - (opts.alpha ?? 0.05)) + normalQuantile(opts.power ?? 0.8);
  const candidate = baseline - delta;
  const variance = baseline * (1 - baseline) + candidate * (1 - candidate);
  return (z * z * variance) / (delta * delta);
}

/**
 * The smallest drop from `baseline` detectable with `runs` runs per version: the δ at which
 * `runsNeeded` equals `runs`, found by bisection. Capped at the baseline itself (a drop to 0).
 */
export function minimumDetectableEffect(
  runs: number,
  baseline: number,
  opts: PowerOptions = {},
): number {
  if (runs <= 0) return baseline;
  let lo = 1e-6;
  let hi = baseline;
  if (runsNeeded(baseline, hi, opts) > runs) return baseline;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (runsNeeded(baseline, mid, opts) > runs) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface PowerReport {
  tasks: number;
  k: number;
  baseline: number;
  /** MDE with every run counted as independent (n = tasks × K). */
  optimistic: number;
  /** MDE with each task counted once (n = tasks). */
  conservative: number;
}

export function powerReport(
  tasks: number,
  k: number,
  baseline: number,
  opts: PowerOptions = {},
): PowerReport {
  return {
    tasks,
    k,
    baseline,
    optimistic: minimumDetectableEffect(tasks * k, baseline, opts),
    conservative: minimumDetectableEffect(tasks, baseline, opts),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)} points`;

export function renderPowerLine(r: PowerReport): string {
  return `Minimum detectable effect (80% power, one-sided α = 0.05): ${pct(r.optimistic)} for ${r.tasks} tasks × K=${r.k} at baseline pass rate ${r.baseline.toFixed(2)} (${pct(r.conservative)} if runs of a task were fully correlated). A smaller difference can exist undetected.`;
}

function option(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === `--${name}`) return argv[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

export function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): number {
  const tasks = Number(option(argv, "tasks") ?? 44);
  const k = Number(option(argv, "k") ?? 5);
  const baseline = Number(option(argv, "baseline") ?? 0.8);
  const power = Number(option(argv, "power") ?? 0.8);
  const alpha = Number(option(argv, "alpha") ?? 0.05);
  const valid =
    Number.isInteger(tasks) &&
    tasks > 0 &&
    Number.isInteger(k) &&
    k > 0 &&
    baseline > 0 &&
    baseline < 1 &&
    power > 0 &&
    power < 1 &&
    alpha > 0 &&
    alpha < 1;
  if (!valid) {
    log(
      "usage: npm run power -- [--tasks 44] [--k 5] [--baseline 0.8] [--power 0.8] [--alpha 0.05]",
    );
    return 2;
  }
  const report = powerReport(tasks, k, baseline, { power, alpha });
  if (power === 0.8 && alpha === 0.05) log(renderPowerLine(report));
  else
    log(
      `Minimum detectable effect (power ${power}, one-sided α = ${alpha}): ${pct(report.optimistic)} for ${tasks} tasks × K=${k} at baseline ${baseline} (${pct(report.conservative)} if runs of a task were fully correlated).`,
    );
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMain()) process.exit(main(process.argv.slice(2)));
