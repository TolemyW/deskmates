// Who may start a campaign of the 2026-10-17 protocol, and against which ceiling (amendment 1,
// the owner's answer of 2026-10-17). A scripted dry run and a campaign whose every configured
// model is priced as known zero need no owner ruling and no ceiling; a campaign with any paid
// model needs the one ceiling the owner authorised for the whole comparison, the same on every
// invocation. The ceiling is pinned in the report directory at the first invocation, so it cannot
// differ between arms or blocks, and a dry run's observations never mix with a model campaign's.
// Model-free: imported by the executors and by the T0 tests.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelPrice } from "@deskmates/contracts";

/** Protocol amendment 1: who must authorise a campaign; the plans print it. */
export const AUTHORISATION: readonly string[] = [
  "A scripted dry run (EVAL_DRY_RUN=scripted) and a campaign whose every model is priced as known zero need no owner ruling.",
  "A campaign with any paid model needs one owner authorisation naming this one ceiling (EVAL_CEILING_USD). None exists: no paid run is authorised.",
];

/** Every price row of the model, and at least one, has all four rates at zero. */
export function knownZero(model: string, prices: readonly ModelPrice[]): boolean {
  const rows = prices.filter((p) => p.model === model);
  return (
    rows.length > 0 &&
    rows.every(
      (r) =>
        r.inputPerM === 0 && r.outputPerM === 0 && r.cacheReadPerM === 0 && r.cacheCreatePerM === 0,
    )
  );
}

export interface CampaignGate {
  /** The authorised ceiling in USD, or null for a known-zero campaign (it may spend nothing). */
  ceilingUsd: number | null;
  /** Configured models priced above zero; empty for a known-zero campaign. */
  paidModels: string[];
}

/**
 * The gate before a stack starts. Refuses a model with no price row (its cost would be unknown,
 * stop rule S2), a malformed ceiling, and a campaign with a paid model but no ceiling. A
 * known-zero campaign may start without `EVAL_CEILING_USD`.
 */
export function campaignGate(
  env: Readonly<Record<string, string | undefined>>,
  models: readonly string[],
  prices: readonly ModelPrice[],
): CampaignGate {
  const distinct = [...new Set(models.map((m) => m.trim()).filter((m) => m !== ""))].sort();
  if (distinct.length === 0) throw new Error("the campaign names no model");
  for (const model of distinct)
    if (!prices.some((p) => p.model === model))
      throw new Error(`no MODEL_PRICES row for ${model}: its cost would be unknown (stop rule S2)`);
  const paidModels = distinct.filter((m) => !knownZero(m, prices));
  const raw = (env.EVAL_CEILING_USD ?? "").trim();
  if (raw !== "") {
    const ceilingUsd = Number(raw);
    if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0)
      throw new Error("EVAL_CEILING_USD must be the owner's authorised ceiling in USD, above 0");
    return { ceilingUsd, paidModels };
  }
  if (paidModels.length > 0)
    throw new Error(
      `EVAL_CEILING_USD is required: ${paidModels.join(", ")} ${paidModels.length === 1 ? "is" : "are"} not priced as known zero, so the campaign needs the one ceiling the owner authorised for the whole comparison`,
    );
  return { ceilingUsd: null, paidModels };
}

/** What the first invocation of a campaign fixes for every later one. */
export interface CampaignPin {
  campaign: string;
  /** `<name>@<version>` of the task set. */
  taskSet: string;
  /** `scripted`: the dry run against a scripted upstream; `model`: a real campaign. */
  mode: "scripted" | "model";
  ceilingUsd: number | null;
}

/** The pin's file name; not `.json`, so no reader of observations ever takes it for one. */
export const CAMPAIGN_PIN_FILE = "campaign.meta";

/**
 * Pin the campaign in its report directory, or check the pin already there. One campaign has one
 * ceiling, one mode and one task set: a different value is a new campaign in a new directory.
 * A directory that already holds observations but no pin is refused too: they came from
 * somewhere this invocation cannot account for.
 */
export function pinCampaign(reportDir: string, pin: CampaignPin): void {
  mkdirSync(reportDir, { recursive: true });
  const file = path.join(reportDir, CAMPAIGN_PIN_FILE);
  if (!existsSync(file)) {
    if (readdirSync(reportDir).some((f) => f.endsWith(".json")))
      throw new Error(
        `${reportDir} holds observations but no ${CAMPAIGN_PIN_FILE}; start the campaign in an empty directory`,
      );
    writeFileSync(file, `${JSON.stringify(pin, null, 2)}\n`, "utf8");
    return;
  }
  const was = JSON.parse(readFileSync(file, "utf8")) as Partial<CampaignPin>;
  const keys = ["campaign", "taskSet", "mode", "ceilingUsd"] as const;
  const differs = keys.filter((k) => (was[k] ?? null) !== pin[k]);
  if (differs.length > 0)
    throw new Error(
      `${file} pins ${differs.map((k) => `${k} ${JSON.stringify(was[k] ?? null)}`).join(", ")}; this invocation has ${differs.map((k) => JSON.stringify(pin[k])).join(", ")}. One campaign has one ceiling: a new ceiling, mode or task set is a new campaign in a new report directory`,
    );
}

/** One invocation of an executor: one arm, one repetition block, and the campaign's ceiling. */
export interface CampaignRun {
  arm: string;
  repeat: number;
  reportDir: string;
  /** The one ceiling of the whole campaign; null for a known-zero campaign. */
  ceilingUsd: number | null;
}

export interface AuthoriseInput {
  campaign: string;
  taskSet: string;
  mode: CampaignPin["mode"];
  /** Every model the campaign may pay for, on every arm. */
  models: readonly string[];
  prices: readonly ModelPrice[];
}

/**
 * `EVAL_ARM`, `EVAL_REPEAT` and `EVAL_REPORT_DIR` (required), the gate, and the pin. Returns the
 * invocation, or throws before anything has started.
 */
export function authoriseCampaign(
  env: Readonly<Record<string, string | undefined>>,
  input: AuthoriseInput,
): CampaignRun {
  const arm = (env.EVAL_ARM ?? "").trim();
  const repeat = Number(env.EVAL_REPEAT ?? "");
  const reportDir = (env.EVAL_REPORT_DIR ?? "").trim();
  if (!arm) throw new Error("EVAL_ARM is required");
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("EVAL_REPEAT must be 1 or more");
  if (!reportDir) throw new Error("EVAL_REPORT_DIR is required");
  const gate = campaignGate(env, input.models, input.prices);
  pinCampaign(reportDir, {
    campaign: input.campaign,
    taskSet: input.taskSet,
    mode: input.mode,
    ceilingUsd: gate.ceilingUsd,
  });
  return { arm, repeat, reportDir, ceilingUsd: gate.ceilingUsd };
}

/**
 * The first batch (the former smoke tasks, amendment 1 A2) runs first in block 1, in the block's
 * seeded order, and the rest of block 1 follows in that order. Every other block is unchanged.
 */
export function firstBatchFirst<T>(
  order: readonly T[],
  inFirstBatch: (item: T) => boolean,
  repeat: number,
): T[] {
  if (repeat !== 1) return [...order];
  return [...order.filter(inFirstBatch), ...order.filter((item) => !inFirstBatch(item))];
}
