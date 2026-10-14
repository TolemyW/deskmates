// Authenticated sidecar endpoints for discovering old browser targets and auditing confirmed
// closes. These routes never close a target themselves and never accept a workspace from input.

import { DeskmatesError, type RunId, type WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import {
  closedRetentionTargets,
  latestIssuedRetentionPlan,
  retentionCandidates,
} from "../workspaces/browser-retention.js";
import { asRecord } from "./validate.js";

type RunParams = { Params: { runId: string } };

function targetIdsFromBody(value: unknown): string[] {
  const body = asRecord(value);
  if (!Array.isArray(body.targetIds))
    throw new DeskmatesError("validation", "targetIds must be an array of target ids");
  if (body.targetIds.length > 20)
    throw new DeskmatesError("validation", "targetIds may contain at most 20 target ids");
  const targetIds = body.targetIds;
  if (
    targetIds.some(
      (targetId) => typeof targetId !== "string" || targetId.length === 0 || targetId.length > 512,
    )
  )
    throw new DeskmatesError("validation", "each target id must be a non-empty string");
  if (new Set(targetIds).size !== targetIds.length)
    throw new DeskmatesError("validation", "targetIds must not contain duplicates");
  return targetIds as string[];
}

function runWorkspace(ctx: GatewayContext, runId: RunId): WorkspaceId {
  return ctx.bots.mustGet(ctx.runs.mustGet(runId).botId).workspaceId;
}

export function registerBrowserRetentionRoutes(scope: FastifyInstance, ctx: GatewayContext): void {
  scope.get<RunParams>("/internal/runs/:runId/browser-retention", async (request) => {
    const runId = request.params.runId as RunId;
    const workspaceId = runWorkspace(ctx, runId);
    const targetIds = retentionCandidates(ctx, runId);
    ctx.events.append({
      runId,
      kind: "log",
      payload: { source: "browser_retention", phase: "planned", workspaceId, targetIds },
    });
    return { targetIds };
  });

  scope.post<RunParams>("/internal/runs/:runId/browser-retention/closed", async (request) => {
    const runId = request.params.runId as RunId;
    const targetIds = targetIdsFromBody(request.body);
    const workspaceId = runWorkspace(ctx, runId);
    const plan = latestIssuedRetentionPlan(ctx, runId);
    const allowed = new Set(plan?.workspaceId === workspaceId ? plan.targetIds : []);
    const alreadyClosed = closedRetentionTargets(ctx, workspaceId);
    const rejectedTargetIds = targetIds.filter(
      (targetId) => !allowed.has(targetId) || alreadyClosed.has(targetId),
    );
    if (rejectedTargetIds.length > 0)
      throw new DeskmatesError(
        "validation",
        "targetIds must be current browser retention candidates",
        { rejectedTargetIds },
      );

    if (targetIds.length > 0)
      ctx.events.append({
        runId,
        kind: "log",
        payload: { source: "browser_retention", phase: "closed", targetIds },
      });
    return { recorded: targetIds.length };
  });
}
