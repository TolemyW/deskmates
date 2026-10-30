// Operator routes for the workspace monetary budget (ADR-0032 decisions 1 and 7). Registered
// inside the operator auth scope; policies are in `route-policies/costs.ts`.

import { DeskmatesError, type RunId, type WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";
import { readableWorkspaceIds } from "./workspace-access.js";

interface WorkspaceParams {
  workspaceId: string;
}

export function registerBudgetRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  const overview = (workspaceId: WorkspaceId) =>
    ctx.budget.overview(workspaceId, ctx.workspaces.mustGet(workspaceId).name);

  app.get("/api/budgets", async (request) => {
    // A workspace's budget and spend reach its Members only (ADR-0022 amendment 6 W1).
    const readable = readableWorkspaceIds(ctx, request, "member");
    const workspaces = ctx.workspaces
      .list(requestTenant(request))
      .filter((w) => readable === undefined || readable.has(w.id));
    return { budgets: workspaces.map((w) => overview(w.id)) };
  });

  app.put<{ Params: WorkspaceParams }>("/api/budgets/:workspaceId", async (request) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const body = asRecord(request.body);
    ctx.budget.setLimits(workspaceId, body, requestActorId(request, body));
    // A raised limit resumes nothing by itself (decision 7); the scheduler only sees new work.
    scheduler.kick();
    return { budget: overview(workspaceId) };
  });

  app.post<{ Params: WorkspaceParams }>("/api/budgets/:workspaceId/continue", async (request) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const body = request.body === undefined || request.body === null ? {} : asRecord(request.body);
    let runIds: RunId[] | undefined;
    if (body.runIds !== undefined) {
      if (!Array.isArray(body.runIds) || body.runIds.some((id) => typeof id !== "string"))
        throw new DeskmatesError("validation", "runIds must be an array of run ids");
      runIds = body.runIds as RunId[];
    }
    const continued = ctx.budget.continueParked(workspaceId, requestActorId(request, body), runIds);
    for (const runId of continued)
      ctx.events.append({
        runId,
        kind: "log",
        payload: { source: "budget", phase: "continued" },
      });
    scheduler.kick();
    return { continued, budget: overview(workspaceId) };
  });
}
