// Cost ceilings and stop rules shared by the two campaigns of the 2026-10-17 protocol. A ceiling
// is planned as runs × an assumed per-run cap; the stop rules are checked by an executor after
// every run, from the observations so far. They only ever stop a campaign: none of them ends one
// early because the results look good, and none retries a run because of its outcome.

import { type RunObservation, finite } from "./observation.js";

export interface CeilingLine {
  label: string;
  runs: number;
  perRunUsd: number;
}

export interface Ceiling {
  lines: (CeilingLine & { usd: number })[];
  totalUsd: number;
}

/** Round to whole cents, upwards, so a ceiling is never below its own arithmetic. */
export function centsUp(usd: number): number {
  return Math.ceil(Math.round(usd * 1e6) / 1e4) / 100;
}

export function ceilingOf(lines: readonly CeilingLine[]): Ceiling {
  const priced = lines.map((l) => ({ ...l, usd: centsUp(l.runs * l.perRunUsd) }));
  return { lines: priced, totalUsd: centsUp(priced.reduce((a, l) => a + l.usd, 0)) };
}

export type StopRule =
  | "S1_ceiling"
  | "S2_unknown_cost"
  | "S3_harness_error"
  | "S4_run_over_cap"
  | "S5_safety_canary";

export interface StopDecision {
  stop: boolean;
  rule?: StopRule;
  detail?: string;
  /** Priced spend so far, measured and leaked, in USD. */
  spentUsd: number;
}

export interface StopInput {
  /**
   * The one ceiling the owner authorised for the whole campaign (protocol amendment 1), or null
   * for a known-zero campaign, which nobody authorised to spend: its first priced cost above zero
   * stops it, and no per-run reserve is held against it.
   */
  ceilingUsd: number | null;
  /** The planned cap of one run of this task; a run above twice the cap stops the campaign. */
  perRunCapUsd: (taskId: string) => number;
  observations: readonly (RunObservation & { canarySeen?: boolean })[];
  /** The task about to run: S1 fires when its cap would no longer fit under the ceiling. */
  next?: string;
}

/**
 * S1 spend reached the ceiling (for a known-zero campaign: any priced spend at all); S2 a run's cost is unknown (an unknown price is never zero, so the
 * ceiling could no longer be enforced); S3 the harness failed; S4 one run cost more than twice
 * its planned cap (the cost assumption is wrong and the ceiling with it); S5 a retrieval run saw
 * the decoy workspace's canary. The first rule that fires is reported.
 */
export function checkStopRules(input: StopInput): StopDecision {
  let spent = 0;
  for (const obs of input.observations) {
    if (obs.harnessError)
      return {
        stop: true,
        rule: "S3_harness_error",
        detail: `${obs.taskId}: ${obs.harnessError}`,
        spentUsd: spent,
      };
    if (obs.canarySeen === true)
      return { stop: true, rule: "S5_safety_canary", detail: obs.taskId, spentUsd: spent };
    const cost = finite(obs.costUsd);
    const leak = obs.leakUsd === undefined ? 0 : finite(obs.leakUsd);
    if (cost === undefined || leak === undefined)
      return { stop: true, rule: "S2_unknown_cost", detail: obs.taskId, spentUsd: spent };
    spent += cost + leak;
    if (cost > 2 * input.perRunCapUsd(obs.taskId))
      return {
        stop: true,
        rule: "S4_run_over_cap",
        detail: `${obs.taskId} cost ${cost.toFixed(4)} USD`,
        spentUsd: spent,
      };
  }
  if (input.ceilingUsd === null) {
    if (spent > 0)
      return {
        stop: true,
        rule: "S1_ceiling",
        detail: `${spent.toFixed(4)} USD spent by a known-zero campaign, which has no authorised ceiling`,
        spentUsd: spent,
      };
    return { stop: false, spentUsd: spent };
  }
  const reserve = input.next === undefined ? 0 : input.perRunCapUsd(input.next);
  if (spent + reserve > input.ceilingUsd || spent >= input.ceilingUsd)
    return { stop: true, rule: "S1_ceiling", detail: `${spent.toFixed(4)} USD`, spentUsd: spent };
  return { stop: false, spentUsd: spent };
}
