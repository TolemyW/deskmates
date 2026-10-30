// Operator routes for the native desktop tools (ADR-0048 decision 1, amendment 1 A1). Registered inside the
// operator auth scope; policies are in `route-policies/desktop-tools.ts`. A change applies to runs
// that first start afterwards; a run already started keeps what it froze.

import type { DesktopToolsView, WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { desktopTools, workspaceImageFacts } from "../desktop/desktop-tools.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

interface WorkspaceParams {
  id: string;
}

export function registerDesktopToolsRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const view = async (workspaceId: WorkspaceId): Promise<DesktopToolsView> => {
    const facts = await workspaceImageFacts(ctx);
    return desktopTools(ctx).view(workspaceId, ctx.bots.list(workspaceId), facts);
  };

  app.get<{ Params: WorkspaceParams }>("/api/workspaces/:id/desktop-tools", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    return { desktopTools: await view(workspaceId) };
  });

  app.put<{ Params: WorkspaceParams }>("/api/workspaces/:id/desktop-tools", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    const body = asRecord(request.body);
    const { authorId: _authorId, ...settings } = body;
    const bots = new Set<string>(ctx.bots.list(workspaceId).map((b) => b.id));
    desktopTools(ctx).set(
      workspaceId,
      settings,
      requestActorId(request, body),
      bots,
      await workspaceImageFacts(ctx),
    );
    return { desktopTools: await view(workspaceId) };
  });
}
