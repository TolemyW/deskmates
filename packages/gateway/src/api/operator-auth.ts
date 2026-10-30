// Authentication boundary for the operator API (ADR-0006 decisions 1 and 2, ADR-0022 P1).
//
// Two credentials reach `/api/*`:
// - a browser session cookie. Every request re-reads the session, so revocation takes effect on
//   the next request; every unsafe method also needs a same-origin `Origin` and the session's
//   CSRF token in `x-deskmates-csrf`.
// - `Authorization: Bearer <GATEWAY_OPERATOR_TOKEN>`, the shared operator credential, kept as the
//   single-tenant maintenance bridge for machine clients (channel adapters, acceptance stack).
// - `Authorization: Bearer deskmates-sp.<...>`, a service principal: a tenant's machine identity
//   acting as a Member there (ADR-0022 amendment 2), looked up by token hash on every request.
// Neither bearer is ever accepted in a URL: the SSE feed authenticates by cookie or header like
// everything else (ADR-0022 decision 4 retires `?token=`).

import { timingSafeEqual } from "node:crypto";
import { CSRF_HEADER, DeskmatesError, TENANT_HEADER } from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { cookieNames, readCookie } from "../auth/cookies.js";
import { isServicePrincipalToken } from "../auth/service-principals.js";
import { csrfTokenFor, sameSecret } from "../auth/tokens.js";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import type { GatewayContext } from "../context.js";
import { bearerToken } from "../model-proxy/model-proxy.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Route patterns whose browser client cannot send the session's CSRF header: Grafana's own
 * frontend behind the analytics relay (ADR-0046 amendment 1 decision 13). Their unsafe methods
 * still need a same-origin `Origin`, and only the root's own session passes them. A fixed list,
 * so a new route cannot opt out of the CSRF check; `analytics-routes.test.ts` checks it equals
 * the relay's routes.
 */
export const ORIGIN_CHECKED_ROUTES: ReadonlySet<string> = new Set(["/analytics", "/analytics/*"]);

function equalToken(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false;
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether a cookie-authenticated mutation comes from an allowed origin. With no configured list
 * the Origin must name the very host the request was sent to; a missing or opaque (`null`)
 * Origin is refused, since every browser that would carry the cookie sends one on POST.
 */
export function originAllowed(request: FastifyRequest, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "" || origin === "null") return false;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function queryTenant(request: FastifyRequest): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.tenant;
  return typeof value === "string" && value.length <= 128 ? value : undefined;
}

export function registerOperatorAuth(app: FastifyInstance, ctx: GatewayContext): void {
  const operatorToken = ctx.config.operatorToken;
  const names = cookieNames(ctx.auth.config.cookieMode);
  app.addHook("preHandler", async (request) => {
    const header = request.headers.authorization;
    if (header !== undefined) {
      const presented = bearerToken(header);
      if (equalToken(presented, operatorToken)) {
        request.principal = { kind: "operator_token", tenantId: DEFAULT_TENANT_ID };
        return;
      }
      // A service principal (ADR-0022 amendment 2), re-read on every request. It acts in its
      // own tenant only; a selector naming another tenant is refused like a session's would be.
      const service =
        presented !== undefined && isServicePrincipalToken(presented)
          ? ctx.auth.resolveServiceToken(presented)
          : undefined;
      const selector = headerValue(request, TENANT_HEADER);
      if (!service || (selector && selector !== service.tenantId))
        throw new DeskmatesError("token_rejected", "missing or invalid operator credential");
      request.principal = service;
      return;
    }
    const sessionToken = readCookie(request, names.session);
    // A tab may act in one tenant per request; the selector is checked, never trusted. The SSE
    // feed is opened by EventSource, which cannot send headers, so it may name it in `?tenant=`.
    const selected =
      headerValue(request, TENANT_HEADER) ??
      (request.method === "GET" &&
      (request.routeOptions.url === "/api/events" ||
        request.routeOptions.url === "/api/workspaces/:id/files")
        ? queryTenant(request)
        : undefined);
    const resolved =
      sessionToken === undefined
        ? undefined
        : ctx.auth.resolve(sessionToken, selected || undefined);
    if (!sessionToken || !resolved)
      throw new DeskmatesError("token_rejected", "missing or invalid operator credential");
    // A password chosen by somebody else admits only session essentials and its own change, on
    // `/auth/*` outside this scope (ADR-0031 decision 8, issue #21).
    if (ctx.auth.mustChangePassword(resolved.session))
      throw new DeskmatesError("forbidden", "change the initial password first", {
        reason: "password_change_required",
      });
    if (!SAFE_METHODS.has(request.method)) {
      if (!originAllowed(request, ctx.auth.config.allowedOrigins))
        throw new DeskmatesError("forbidden", "cross-origin request refused", { reason: "origin" });
      if (
        !ORIGIN_CHECKED_ROUTES.has(request.routeOptions.url ?? "") &&
        !sameSecret(headerValue(request, CSRF_HEADER), csrfTokenFor(sessionToken))
      )
        throw new DeskmatesError("forbidden", "missing or invalid CSRF token", { reason: "csrf" });
    }
    request.principal = resolved.principal;
  });
}
