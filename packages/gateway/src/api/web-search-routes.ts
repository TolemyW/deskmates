// Operator routes for the `web_search` switch (ADR-0049 decision 4). Registered inside the operator
// auth scope; policies are in `route-policies/web-search.ts`. A change applies to runs that first
// start afterwards; a run already started keeps what it froze (decision 12).

import type { WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { webSearchSettings } from "../search/web-search-settings.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

interface WorkspaceParams {
  id: string;
}

export function registerWebSearchRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: WorkspaceParams }>("/api/workspaces/:id/web-search", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    return { webSearch: webSearchSettings(ctx).view(workspaceId) };
  });

  app.put<{ Params: WorkspaceParams }>("/api/workspaces/:id/web-search", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    const body = asRecord(request.body);
    const { authorId: _authorId, ...settings } = body;
    webSearchSettings(ctx).set(workspaceId, settings, requestActorId(request, body));
    return { webSearch: webSearchSettings(ctx).view(workspaceId) };
  });
}
