// Integration routes (ADR-0013). Operator routes adopt providers, give the runtime OAuth apps and
// manage a workspace's connections on the authenticated operator listener; no response carries a
// credential. The OAuth callback is on the same listener but outside the operator scope: the
// provider redirects the operator's browser there without a Bearer header, so the one-time `state`
// the grant was started with is its credential, and anything else is 401. Run routes, on the
// sandbox listener, let a sidecar reach its own workspace's integrations with its run token.

import {
  DeskmatesError,
  type IntegrationConnection,
  type IntegrationConnectionPage,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  type RunId,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cookieNames, readCookie } from "../auth/cookies.js";
import type { GatewayContext } from "../context.js";
import { bearerToken } from "../model-proxy/model-proxy.js";
import { requestActorId } from "./actor.js";
import { parseOffsetQuery } from "./pagination.js";
import { roleAtLeast } from "./route-policy.js";
import { asRecord } from "./validate.js";

/** A workspace's integration connections: 25 a page, at most 100 (#113). */
export const CONNECTION_PAGE: PageLimitPolicy = { default: 25, max: PAGE_LIMIT_MAX };

type WorkspaceParams = { Params: { workspaceId: string } };
type ConnectionParams = { Params: { workspaceId: string; connectionId: string } };
type ServiceParams = { Params: { service: string } };
type ActionParams = { Params: { actionId: string } };

/** Registered inside the authenticated operator scope. */
export function registerIntegrationRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const svc = ctx.integrations;
  app.get("/api/integrations", async () => svc.status());
  app.get("/api/integrations/catalog", async () => svc.providerCatalog());
  app.post("/api/integrations/providers", async (request, reply) => {
    const body = asRecord(request.body);
    const provider = await svc.adopt(body.service, body.displayName);
    return reply.code(201).send({ provider });
  });
  app.delete<ServiceParams>("/api/integrations/providers/:service", async (request) => {
    await svc.unadopt(request.params.service);
    return { ok: true };
  });
  app.put<ServiceParams>("/api/integrations/providers/:service/oauth-app", async (request) =>
    svc.setOAuthApp(request.params.service, asRecord(request.body)),
  );
  // One page of a workspace's connections, oldest first, with the honest total and the live
  // count of every service over the whole workspace (#113).
  app.get<WorkspaceParams & { Querystring: Record<string, unknown> }>(
    "/api/integrations/workspaces/:workspaceId/connections",
    async (request): Promise<IntegrationConnectionPage> => {
      const { offset, limit } = parseOffsetQuery(request.query, CONNECTION_PAGE);
      const raw = request.query.status;
      const status = raw === "live" || raw === "revoked" ? raw : undefined;
      if (status === undefined && raw !== undefined && raw !== "")
        throw new DeskmatesError("validation", "status must be live or revoked", {
          field: "status",
        });
      return svc.connectionPage(request.params.workspaceId as WorkspaceId, status, offset, limit);
    },
  );
  app.post<WorkspaceParams>(
    "/api/integrations/workspaces/:workspaceId/connections/api-key",
    async (request, reply) => {
      const body = asRecord(request.body);
      const connection = await svc.createApiKeyConnection(
        request.params.workspaceId as WorkspaceId,
        body,
        decidedByHuman(requestActorId(request, body)),
      );
      return reply.code(201).send({ connection });
    },
  );
  app.post<WorkspaceParams>(
    "/api/integrations/workspaces/:workspaceId/connections/oauth/start",
    async (request) =>
      svc.startOAuth(
        request.params.workspaceId as WorkspaceId,
        asRecord(request.body),
        request.principal?.kind === "user" ? request.principal.sessionId : undefined,
      ),
  );
  app.delete<ConnectionParams>(
    "/api/integrations/workspaces/:workspaceId/connections/:connectionId",
    async (request) => ({
      connection: await svc.revokeConnection(
        request.params.workspaceId as WorkspaceId,
        request.params.connectionId,
        decidedByHuman(requestActorId(request, request.body ?? {})),
      ),
    }),
  );
  app.get("/api/integrations/actions/overrides", async () => ({
    overrides: svc.listOverrides(),
  }));
  app.put<ActionParams>("/api/integrations/actions/:actionId/override", async (request) => ({
    override: await svc.setOverride(request.params.actionId, asRecord(request.body)),
  }));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(reply: FastifyReply, status: number, title: string, text: string): FastifyReply {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><p>${escapeHtml(text)}</p>`,
    );
}

/**
 * `GET /api/integrations/oauth/callback`, on the operator listener outside the Bearer scope. An
 * unknown, used or expired `state` is 401 before the runtime is asked anything (the error handler
 * answers it as JSON like every other refusal).
 */
export function registerIntegrationOAuthCallbackRoute(
  app: FastifyInstance,
  ctx: GatewayContext,
): void {
  app.get("/api/integrations/oauth/callback", async (request, reply) => {
    const query = new URLSearchParams(request.url.split("?", 2)[1] ?? "");
    // A grant started from a browser session completes only in that session, while it is still
    // an Admin of the workspace's tenant: a swapped callback URL or a revoked session finds a
    // spent state and nothing recorded.
    const sessionToken = readCookie(request, cookieNames(ctx.auth.config.cookieMode).session);
    const outcome = await ctx.integrations.completeOAuth(query, (pending) => {
      if (pending.sessionId === undefined) return true;
      const tenantId = ctx.ownership.tenantOf("workspace", pending.workspaceId);
      const resolved =
        sessionToken === undefined || tenantId === undefined
          ? undefined
          : ctx.auth.resolve(sessionToken, tenantId);
      return (
        resolved !== undefined &&
        resolved.session.id === pending.sessionId &&
        roleAtLeast(resolved.principal.role, "admin")
      );
    });
    if (!outcome.ok)
      return page(
        reply,
        400,
        "Connection not completed",
        `The ${outcome.service} grant did not complete (${outcome.code}). Start it again from Deskmates.`,
      );
    const c: IntegrationConnection = outcome.connection;
    return page(
      reply,
      200,
      "Connected",
      `Connected ${c.service} as ${c.connectionName}. You can close this tab.`,
    );
  });
}

type RunParams = { Params: { runId: string } };
type RunActionParams = { Params: { runId: string; actionId: string } };

const PREFIX = "/internal/runs/:runId/integrations";

/**
 * Run-token routes in their own scope, so another run's token is 403 rather than 401 (as for
 * connectors). Registered on the sandbox listener only.
 */
export function registerIntegrationInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const svc = ctx.integrations;
  app.register(async (scope) => {
    scope.addHook("preHandler", async (request: FastifyRequest<RunParams>) => {
      const token = bearerToken(request.headers.authorization);
      const verified = token ? ctx.tokens.verify(token) : undefined;
      if (!verified)
        throw new DeskmatesError("token_rejected", "missing, expired or revoked run token", {
          runId: request.params.runId,
        });
      if (verified.runId !== request.params.runId)
        throw new DeskmatesError("forbidden", "the run token belongs to another run", {
          runId: request.params.runId,
        });
    });
    const runId = (request: FastifyRequest<RunParams>) => request.params.runId as RunId;

    scope.get<RunParams>(`${PREFIX}/apps`, async (request) => svc.apps(runId(request)));
    scope.get<RunParams & { Querystring: { service?: string } }>(
      `${PREFIX}/connections`,
      async (request) => svc.connections(runId(request), request.query.service || undefined),
    );
    scope.post<RunParams>(`${PREFIX}/search`, async (request) =>
      svc.search(runId(request), asRecord(request.body)),
    );
    scope.post<RunParams>(`${PREFIX}/guide`, async (request) =>
      svc.guide(runId(request), asRecord(request.body)),
    );
    scope.post<RunParams>(`${PREFIX}/execute`, async (request) =>
      svc.execute(runId(request), asRecord(request.body)),
    );
    // What the PreToolUse hook reads to tier an execute: the catalog's operationType and the
    // operator's override, never the tool input.
    scope.get<RunActionParams & { Querystring: { connectionName?: string } }>(
      `${PREFIX}/actions/:actionId/tier`,
      async (request) =>
        svc.tier(
          request.params.runId as RunId,
          request.params.actionId,
          request.query.connectionName,
        ),
    );
  });
}
