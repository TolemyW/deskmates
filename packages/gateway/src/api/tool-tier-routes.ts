// A workspace operator's tool tier overrides (ADR-0002 amendment 3, A5). Any member reads them;
// an Owner or Admin sets or removes one (route policy). These are operator routes: a run token
// never authenticates here, so an override is never a bot action. No override is the default.

import { DeskmatesError, type WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { ToolTierOverrides } from "../approvals/tool-tier-overrides.js";
import type { GatewayContext } from "../context.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

export function registerToolTierRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/tool-tiers", async (request) => {
    const workspaceId = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(workspaceId);
    return { overrides: new ToolTierOverrides(ctx.db).list(workspaceId) };
  });

  app.put<{ Params: { id: string; toolName: string } }>(
    "/api/workspaces/:id/tool-tiers/:toolName",
    async (request) => {
      const workspaceId = request.params.id as WorkspaceId;
      ctx.workspaces.mustGet(workspaceId);
      const body = asRecord(request.body);
      const override = new ToolTierOverrides(ctx.db).set(
        workspaceId,
        request.params.toolName,
        body.riskLevel,
        requestActorId(request, body),
      );
      return { override };
    },
  );

  app.delete<{ Params: { id: string; toolName: string } }>(
    "/api/workspaces/:id/tool-tiers/:toolName",
    async (request) => {
      const workspaceId = request.params.id as WorkspaceId;
      ctx.workspaces.mustGet(workspaceId);
      const removed = new ToolTierOverrides(ctx.db).remove(
        workspaceId,
        request.params.toolName,
        requestActorId(request, request.body ?? {}),
      );
      if (!removed)
        throw new DeskmatesError("not_found", "no tier override for this tool", {
          toolName: request.params.toolName,
        });
      return { deleted: true };
    },
  );
}
