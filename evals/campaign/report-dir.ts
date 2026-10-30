// The report directory of a campaign of the 2026-10-17 protocol: the observations already in it
// (the whole campaign's spend so far, every arm and block), the stop-rule check before every
// task, one file per observation, and the seeded task order of a block. Model-free: used by the
// executors and by the T1 dry run of the analysis path.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type StopDecision, checkStopRules } from "./ceiling.js";
import type { CampaignRun } from "./gate.js";
import type { RunObservation } from "./observation.js";

/** Every observation already in the report directory: the whole campaign's spend so far. */
export function previousObservations(dir: string): RunObservation[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as RunObservation);
}

/** Stop-rule check before the next task; throws, so the executor stops, when a rule fires. */
export function guard(
  run: CampaignRun,
  perRunCapUsd: (taskId: string) => number,
  next: string,
): StopDecision {
  const decision = checkStopRules({
    ceilingUsd: run.ceilingUsd,
    perRunCapUsd,
    observations: previousObservations(run.reportDir),
    next,
  });
  if (decision.stop)
    throw new Error(
      `campaign stopped by ${decision.rule}: ${decision.detail ?? ""} (spent ${decision.spentUsd.toFixed(4)} USD)`,
    );
  return decision;
}

/** One file per observation, named so a repetition never overwrites another. */
export function writeObservation(
  run: CampaignRun,
  obs: RunObservation,
  secrets: readonly string[],
): void {
  let json = JSON.stringify(obs, null, 2);
  for (const secret of secrets) if (secret) json = json.replaceAll(secret, "[redacted]");
  const name = `${obs.taskId}__${obs.arm}__r${obs.repeat}.json`.replace(/[^A-Za-z0-9_.@-]/g, "_");
  writeFileSync(path.join(run.reportDir, name), `${json}\n`, "utf8");
}

/** A deterministic task order for one repetition: a seeded Fisher-Yates shuffle. */
export function taskOrder<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
