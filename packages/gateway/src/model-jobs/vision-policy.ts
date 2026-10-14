// What a run does with images (ADR-0023 amendment 2, decision 11). At start the run records the
// capability of its frozen model (amendment 1, decision 9) and the policy derived from it; a
// resume keeps both, so one SDK session never changes what it is shown halfway through.

import {
  type RunModelCapabilities,
  type StartRunRequest,
  type VisionPolicy,
  type WorkspaceId,
  visionPolicyFor,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { MODEL_JOB_RUN_TYPES } from "./model-jobs.js";

function isVisionPolicy(value: unknown): value is VisionPolicy {
  return value === "deliver" || value === "withhold";
}

/**
 * The `runs.config_json` keys to write (only the missing ones) and the request field. A model job
 * records its capability snapshot but no policy: the probe must always send its image. A run
 * recorded before amendment 2 has a capability but no policy; its first attempt delivered, so
 * its resume does too.
 */
export function visionStart(
  ctx: GatewayContext,
  run: RunRecord,
  workspaceId: WorkspaceId,
  model: string,
): { patch: Record<string, unknown>; request: Pick<StartRunRequest, "visionPolicy"> } {
  const patch: Record<string, unknown> = {};
  const recordedCapabilities = "modelCapabilities" in run.config;
  if (!recordedCapabilities)
    patch.modelCapabilities = ctx.modelJobs.vision.snapshot(workspaceId, model);
  if (MODEL_JOB_RUN_TYPES.has(run.config.runType)) return { patch, request: {} };
  let policy: VisionPolicy;
  if (isVisionPolicy(run.config.visionPolicy)) policy = run.config.visionPolicy;
  else {
    policy = recordedCapabilities
      ? "deliver"
      : visionPolicyFor((patch.modelCapabilities as RunModelCapabilities).vision);
    patch.visionPolicy = policy;
  }
  return { patch, request: policy === "withhold" ? { visionPolicy: "withhold" } : {} };
}
