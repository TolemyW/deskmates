// Operator routes for workspace execution limits (ADR-0005 amendment 5 decisions 37 to 41,
// ADR-0016 amendment 2 decision 13). Registered inside the operator auth scope; policies are in
// `route-policies/limits.ts`. A change applies to the next bot message and to runs that start
// afterwards; it never resumes, unpauses or re-freezes anything.

import type { WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

interface WorkspaceParams {
  id: string;
}

export function registerLimitRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: WorkspaceParams }>("/api/workspaces/:id/limits", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    return { limits: ctx.limits.view(workspaceId) };
  });

  app.put<{ Params: WorkspaceParams }>("/api/workspaces/:id/limits", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    const body = asRecord(request.body);
    const { authorId: _authorId, ...settings } = body;
    ctx.limits.set(workspaceId, settings, requestActorId(request, body));
    return { limits: ctx.limits.view(workspaceId) };
  });
}
