// Routes for published workspace apps (ADR-0035). Operator routes sit in the operator scope with
// policies in `api/route-policies/app-shares.ts` and are nested under the workspace, so the guard
// resolves the workspace and the handler refuses a publication of another one (decision 9). The
// bot's route sits in the run-token scope of `/internal/runs/:runId/*`.

import {
  type AppPublishResponse,
  type AppShare,
  type AppShareOpenResponse,
  DeskmatesError,
  type RunId,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { appSharesOf } from "./app-share-module.js";
import { type AppShareRow, hasControlCharacter } from "./app-share-store.js";

interface ShareParams {
  id: string;
  shareId: string;
}

function shareIn(ctx: GatewayContext, workspaceId: string, shareId: string): AppShareRow {
  const row = appSharesOf(ctx).store.get(shareId);
  // Another workspace’s publication answers exactly like a missing one.
  if (!row || row.workspaceId !== workspaceId)
    throw new DeskmatesError("not_found", "app share not found");
  return row;
}

/** A landing path on the app origin: absolute, no scheme or authority, bounded. */
function landingPath(value: unknown): string {
  if (value === undefined || value === null || value === "") return "/";
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.length > 2048 ||
    hasControlCharacter(value)
  )
    throw new DeskmatesError("validation", "path must be an absolute path on the app", {
      field: "path",
    });
  return value;
}

export function registerAppShareRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/app-shares",
    async (request): Promise<{ enabled: boolean; shares: AppShare[] }> => {
      const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
      const shares = appSharesOf(ctx);
      return { enabled: shares.config !== undefined, shares: await shares.list(workspaceId) };
    },
  );

  app.post<{ Params: ShareParams }>(
    "/api/workspaces/:id/app-shares/:shareId/open",
    async (request, reply): Promise<AppShareOpenResponse> => {
      reply.header("cache-control", "no-store");
      const row = shareIn(ctx, request.params.id, request.params.shareId);
      const principal = request.principal;
      // An app runs in a person's browser; machine credentials have no browser session.
      if (principal?.kind !== "user")
        throw new DeskmatesError("forbidden", "only a signed-in person opens a published app", {
          reason: "person_only",
        });
      const body = (request.body ?? {}) as Record<string, unknown>;
      return appSharesOf(ctx).issueTicket(
        row,
        { userId: principal.userId, sessionId: principal.sessionId, tenantId: principal.tenantId },
        landingPath(body.path),
      );
    },
  );

  app.delete<{ Params: ShareParams }>(
    "/api/workspaces/:id/app-shares/:shareId",
    async (request): Promise<{ share: AppShare }> => {
      const row = shareIn(ctx, request.params.id, request.params.shareId);
      const shares = appSharesOf(ctx);
      return { share: await shares.view(shares.revoke(row.id, actorLabel(request.principal))) };
    },
  );
}

export function registerAppShareInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.post<{ Params: { runId: string } }>(
    "/internal/runs/:runId/app-shares",
    async (request): Promise<AppPublishResponse> => {
      const runId = request.params.runId as RunId;
      const run = ctx.runs.mustGet(runId);
      const bot = ctx.bots.mustGet(run.botId);
      const shares = appSharesOf(ctx);
      shares.enabled();
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { share, existing } = shares.store.publish({
        workspaceId: bot.workspaceId,
        port: body.port,
        label: body.label,
        botId: bot.id,
        runId,
      });
      ctx.events.append({
        runId,
        kind: "log",
        payload: { tool: "app_publish", shareId: share.id, port: share.port, existing },
      });
      return { share: await shares.view(share), existing };
    },
  );
}
