import type { ModelPrice } from "@deskmates/contracts";
import { campaignGate } from "../campaign/gate.js";

/** The current owner scope allows known-zero internal models, no paid campaign. */
export function authoriseLongHorizon(
  env: Readonly<Record<string, string | undefined>>,
  models: readonly string[],
  prices: readonly ModelPrice[],
): { repeat: number; arm: string; reportDir: string } {
  if (env.EVAL_CAMPAIGN !== "long-horizon-v2")
    throw new Error("long-horizon executor is not enabled");
  const repeat = Number(env.EVAL_REPEAT);
  const arm = env.EVAL_ARM?.trim();
  const reportDir = env.EVAL_REPORT_DIR?.trim();
  if (
    !Number.isSafeInteger(repeat) ||
    repeat < 1 ||
    !arm ||
    !/^[A-Za-z0-9_-]+$/.test(arm) ||
    !reportDir
  )
    throw new Error(
      "set EVAL_REPEAT (positive integer), EVAL_ARM (label), EVAL_REPORT_DIR (private directory)",
    );
  const gate = campaignGate(env, models, prices);
  if (gate.paidModels.length)
    throw new Error(
      "long-horizon: only known-zero models are authorised; a numeric ceiling does not authorise a paid campaign",
    );
  return { repeat, arm, reportDir };
}
