// Operator routes for working-directory settings (ADR-0036 decision 1). Registered inside the
// operator auth scope; policies are in `route-policies/workdir.ts`. A change applies to runs that
// first start afterwards; a run already started keeps what it froze (decision 3).

import type { WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

interface WorkspaceParams {
  id: string;
}

export function registerWorkdirRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: WorkspaceParams }>("/api/workspaces/:id/workdir", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    return { workdir: ctx.workdir.view(workspaceId) };
  });

  app.put<{ Params: WorkspaceParams }>("/api/workspaces/:id/workdir", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    const body = asRecord(request.body);
    const { authorId: _authorId, ...settings } = body;
    ctx.workdir.set(workspaceId, settings, requestActorId(request, body));
    return { workdir: ctx.workdir.view(workspaceId) };
  });
}
