// ADR-0016 amendment 2: the per-attempt turn cap and the continuation limit, resolved from the
// workspace's settings when a run first starts and frozen in `runs.config_json`, so resumes,
// continuations and budget continuations keep the rules the run started with.

import {
  CONTINUATION_LIMIT_DEFAULT,
  CONTINUATION_WINDOW_HOURS_DEFAULT,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { CONSOLIDATION_RUN_TYPE } from "../memory/consolidation.js";

type Config = RunRecord["config"];

const frozen = (config: Config): boolean => config.limitsVersion === 1;

/** The `maxTurns` a StartRunRequest carries; null is the workspace's `off`. */
export function runMaxTurns(config: Config, gatewayMaxTurns: number): number | null {
  // Only a frozen explicit null is `off`; anything not a positive number falls back to the
  // Gateway's value, so a malformed row never turns the cap off by accident.
  if (frozen(config) && config.maxTurns === null) return null;
  const value = Number(config.maxTurns ?? gatewayMaxTurns);
  return Number.isInteger(value) && value > 0 ? value : gatewayMaxTurns;
}

/**
 * Decision 16: stamp the workspace's limits on a run's first start and return its `maxTurns`.
 * A model job (a `runType` other than memory consolidation) keeps the fixed `maxTurns` it was
 * created with (decision 14). Idempotent: an already frozen run keeps its values.
 */
export function freezeRunLimits(
  ctx: Pick<GatewayContext, "limits" | "runs" | "config">,
  run: RunRecord,
  workspaceId: WorkspaceId,
): number | null {
  const runType = run.config.runType;
  if (frozen(run.config) || (typeof runType === "string" && runType !== CONSOLIDATION_RUN_TYPE))
    return runMaxTurns(run.config, ctx.config.maxTurns);
  const limits = ctx.limits.runLimits(workspaceId);
  ctx.runs.setConfig(run.id, { ...limits });
  return limits.maxTurns;
}

/** Decisions 14 and 15: the frozen continuation limit (null is `off`) and answer window. */
export function continuationPolicy(config: Config): {
  limit: number | null;
  windowHours: number;
} {
  if (!frozen(config))
    return { limit: CONTINUATION_LIMIT_DEFAULT, windowHours: CONTINUATION_WINDOW_HOURS_DEFAULT };
  return {
    limit: typeof config.continuationLimit === "number" ? config.continuationLimit : null,
    windowHours:
      typeof config.continuationWindowHours === "number"
        ? config.continuationWindowHours
        : CONTINUATION_WINDOW_HOURS_DEFAULT,
  };
}

/** Whether another continuation may be offered after `count` earlier ones. */
export function continuationAllowed(config: Config, count: number): boolean {
  const { limit } = continuationPolicy(config);
  return limit === null || count < limit;
}
