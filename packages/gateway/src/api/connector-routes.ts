// Connector routes (ADR-0012). Operator routes register and list connectors on the authenticated
// operator listener; nothing there ever returns a URL or a credential. Run routes, on the sandbox
// listener, let a sidecar reach its workspace's connectors through the proxy with its run token.

import {
  type ConnectorPage,
  DeskmatesError,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  type RunId,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { bearerToken } from "../model-proxy/model-proxy.js";
import { requestActorId } from "./actor.js";
import { parseOffsetQuery } from "./pagination.js";
import { isPlatformPrincipal, requestTenant } from "./route-policy.js";
import { asRecord, optionalString, requireString } from "./validate.js";

/** Registered connectors: 25 a page, at most 100 (#113). */
export const CONNECTOR_PAGE: PageLimitPolicy = { default: 25, max: PAGE_LIMIT_MAX };

/** Registered inside the authenticated operator scope. */
export function registerConnectorRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.post("/api/connectors", async (request, reply) => {
    const body = asRecord(request.body);
    const kind = optionalString(body, "kind");
    const credential = body.credential;
    if (credential !== undefined && typeof credential !== "string")
      throw new DeskmatesError("validation", "credential must be a string");
    if (body.publicUrl !== undefined && typeof body.publicUrl !== "boolean")
      throw new DeskmatesError("validation", "publicUrl must be a boolean");
    // A non-public URL is reached from the Gateway's own network, so only platform maintenance
    // may register one; a tenant Admin may register public URLs only (ADR-0022 INT-02).
    if (body.publicUrl !== true && !isPlatformPrincipal(ctx, request.principal))
      throw new DeskmatesError(
        "forbidden",
        "only platform maintenance may register a connector on a private network",
        { reason: "private_connector" },
      );
    const actor = decidedByHuman(requestActorId(request, body));
    const workspaceId = requireString(body, "workspaceId") as WorkspaceId;
    const url = requireString(body, "url");
    const publicUrl = body.publicUrl;
    const connector = ctx.db.transaction(() => {
      const registered = ctx.connectors.register({
        workspaceId,
        name: requireString(body, "name"),
        url,
        ...(kind === undefined ? {} : { kind }),
        ...(credential === undefined ? {} : { credential }),
        ...(typeof publicUrl === "boolean" ? { publicUrl } : {}),
      });
      // URL and credential stay encrypted (ADR-0012); the record names the connector only.
      ctx.audit.record({
        action: "connector.create",
        actor,
        workspaceId,
        targetKind: "connector",
        targetId: registered.id,
        after: { name: registered.name, kind: registered.kind, publicUrl: publicUrl === true },
      });
      return registered;
    })();
    return reply.code(201).send({ connector });
  });
  // One page of connectors, oldest first, with the honest total (#113).
  app.get<{ Querystring: { workspaceId?: string; offset?: unknown; limit?: unknown } }>(
    "/api/connectors",
    async (request): Promise<ConnectorPage> => {
      const { offset, limit } = parseOffsetQuery(request.query, CONNECTOR_PAGE);
      const page = ctx.connectors.page(
        (request.query.workspaceId || undefined) as WorkspaceId | undefined,
        requestTenant(request),
        offset,
        limit,
      );
      return { connectors: page.connectors, offset, limit, total: page.total };
    },
  );
  app.get<{ Params: { id: string } }>("/api/connectors/:id", async (request) => ({
    connector: ctx.connectors.mustGet(request.params.id),
  }));
}

type ConnectorParams = { Params: { runId: string; connector: string } };
type ReceiptParams = { Params: { runId: string; connector: string; receiptId: string } };
type ValidationParams = { Params: { runId: string; connector: string; validationId: string } };

const PREFIX = "/internal/runs/:runId/connectors/:connector";

/**
 * Run-token routes, in their own scope so a token of another run is 403 rather than 401: it is a
 * valid credential that does not cover this run (ADR-0012 verification row 2). A missing, expired
 * or revoked token is still 401. Registered on the sandbox listener only.
 */
export function registerConnectorInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.register(async (scope) => {
    scope.addHook("preHandler", async (request: FastifyRequest<{ Params: { runId: string } }>) => {
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

    scope.post<ConnectorParams>(`${PREFIX}/describe`, async (request) => ({
      capabilities: await ctx.connectorProxy.describe(
        request.params.runId as RunId,
        request.params.connector,
      ),
    }));

    scope.post<ConnectorParams>(`${PREFIX}/validate`, async (request) => {
      const body = asRecord(request.body);
      return {
        validation: await ctx.connectorProxy.validate(
          request.params.runId as RunId,
          request.params.connector,
          body.submission,
        ),
      };
    });

    scope.post<ConnectorParams>(`${PREFIX}/submit`, async (request) => {
      const body = asRecord(request.body);
      return ctx.connectorProxy.submit(request.params.runId as RunId, request.params.connector, {
        validationId: body.validationId,
        contentHash: body.contentHash,
        ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
      });
    });

    scope.get<ReceiptParams>(`${PREFIX}/status/:receiptId`, async (request) => ({
      receipt: await ctx.connectorProxy.status(
        request.params.runId as RunId,
        request.params.connector,
        request.params.receiptId,
      ),
    }));

    scope.get<ReceiptParams>(`${PREFIX}/receipt/:receiptId`, async (request) => ({
      receipt: await ctx.connectorProxy.receipt(
        request.params.runId as RunId,
        request.params.connector,
        request.params.receiptId,
      ),
    }));

    // What the PreToolUse hook reads to tier a submit: the stored effect, never the tool input.
    scope.get<ValidationParams>(`${PREFIX}/validations/:validationId`, async (request) => ({
      validation: ctx.connectorProxy.validation(
        request.params.runId as RunId,
        request.params.connector,
        request.params.validationId,
      ),
    }));
  });
}
