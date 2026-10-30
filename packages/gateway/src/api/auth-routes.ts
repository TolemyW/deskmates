// Browser sign-in routes (ADR-0022 P1), on the operator listener beside `/api/*` but outside its
// authentication hook. None is blanket-exempt from CSRF defences:
// - `GET /auth/session` reports the session, or hands an anonymous browser a pre-login token
//   bound to an HttpOnly pre-login cookie;
// - `POST /auth/login` needs a same-origin Origin and that pre-login token (login CSRF);
// - logout, logout-all and password change need a same-origin Origin and the session's CSRF token.
// Responses are `no-store`; no response body or log line carries a session token.

import {
  type AnonymousSessionView,
  type AuthTenantChoice,
  type AuthenticatedSessionView,
  CSRF_HEADER,
  DeskmatesError,
  type InvitationPreview,
  type InvitationTargetView,
  type OidcStartResponse,
  SSO_ERROR_PARAM,
  TENANT_HEADER,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ResolvedSession } from "../auth/auth-service.js";
import { cookieNames, readCookie, serializeCookie } from "../auth/cookies.js";
import type { Invitation } from "../auth/invitations.js";
import { LoginThrottle } from "../auth/login-throttle.js";
import { OidcFlowError } from "../auth/oidc-service.js";
import type { OidcPurpose } from "../auth/oidc-store.js";
import { accountView, avatarUrl } from "../auth/profile.js";
import { csrfTokenFor, newOpaqueToken, sameSecret } from "../auth/tokens.js";
import type { GatewayContext } from "../context.js";
import { headerValue, originAllowed } from "./operator-auth.js";
import { asRecord } from "./validate.js";

const LOGIN_COOKIE_MAX_AGE_SECONDS = 60 * 60;
/** Sign-in starts one client address may make per window; each one stores a transaction. */
export const OIDC_LOGIN_STARTS_PER_ADDRESS = 300;
const OIDC_LOGIN_START_WINDOW_MS = 10 * 60 * 1000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{16,128}$/;

function loginCsrfFor(loginCookie: string): string {
  return csrfTokenFor(`login:${loginCookie}`);
}

function requiredString(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new DeskmatesError("validation", `${key} is required`);
  return value;
}

function optionalBoundedString(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new DeskmatesError(
      "validation",
      `${key} must be a string no longer than ${max} characters`,
    );
  return value;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const auth = ctx.auth;
  const names = cookieNames(auth.config.cookieMode);
  const mode = auth.config.cookieMode;
  // A sign-in start needs no account, and each stores a transaction row until it expires. The
  // login throttle's bounded per-address window counts them: every start spends one unit.
  const loginStarts = new LoginThrottle({
    windowMs: OIDC_LOGIN_START_WINDOW_MS,
    perLoginName: Number.MAX_SAFE_INTEGER,
    perAddress: OIDC_LOGIN_STARTS_PER_ADDRESS,
  });

  const sessionView = (
    resolved: ResolvedSession,
    sessionToken: string,
  ): AuthenticatedSessionView => {
    const tenant = auth.users.getTenant(resolved.principal.tenantId);
    const avatar = auth.users.avatarMeta(resolved.principal.userId);
    return {
      authenticated: true,
      ...(auth.mustChangePassword(resolved.session) ? { passwordChangeRequired: true } : {}),
      user: {
        id: resolved.principal.userId,
        displayName: resolved.principal.displayName,
        loginName: resolved.principal.loginName,
        avatarUrl: avatar ? avatarUrl(avatar.sha256) : null,
      },
      account: accountView(auth.users, resolved.principal.userId, resolved.session.loginId),
      tenant: {
        id: resolved.principal.tenantId,
        name: tenant?.name ?? resolved.principal.tenantId,
        role: resolved.principal.role,
      },
      session: {
        authenticatedAt: resolved.session.authenticatedAt,
        idleExpiresAt: resolved.session.idleExpiresAt,
        absoluteExpiresAt: resolved.session.absoluteExpiresAt,
      },
      csrfToken: csrfTokenFor(sessionToken),
      tenants: tenantChoices(resolved),
      platformMaintainer:
        auth.users.getUser(resolved.principal.userId)?.platformRole === "maintainer",
      // Roles are per workspace (ADR-0022 amendment 6 W11); the root is Owner of every one.
      root: auth.users.isProtected(resolved.principal.userId),
      workspaceRoles: auth.workspaceRolesOf(resolved.principal.tenantId, resolved.principal.userId),
      preferences: auth.users.getPreferences(resolved.principal.userId),
    };
  };

  /** The person's own tenants, each with whether this session may enter it now. */
  const tenantChoices = (resolved: ResolvedSession): AuthTenantChoice[] => {
    const enterable = new Set(auth.enterableTenants(resolved.session));
    return auth.users.activeMemberships(resolved.principal.userId).map((membership) => {
      const tenant = auth.users.getTenant(membership.tenantId);
      return {
        id: membership.tenantId,
        name: tenant?.name ?? membership.tenantId,
        role: membership.role,
        enterable: enterable.has(membership.tenantId),
        ssoProviders: ctx.oidc.store
          .tenantProviders(membership.tenantId)
          .map((provider) => ({ id: provider.id, displayName: provider.displayName })),
      };
    });
  };

  const setSessionCookie = (reply: FastifyReply, token: string): void => {
    reply.header("set-cookie", [
      serializeCookie(names.session, token, mode, auth.config.sessionAbsoluteTtlSeconds),
      serializeCookie(names.login, "", mode, 0),
    ]);
  };

  const clearSessionCookie = (reply: FastifyReply): void => {
    reply.header("set-cookie", serializeCookie(names.session, "", mode, 0));
  };

  /** A cookie-authenticated mutation: live session, allowed Origin, matching CSRF token. */
  const requireSessionMutation = (
    request: FastifyRequest,
    allowWhilePasswordChangeRequired = false,
  ): { token: string; resolved: ResolvedSession } => {
    if (!originAllowed(request, auth.config.allowedOrigins))
      throw new DeskmatesError("forbidden", "cross-origin request refused", { reason: "origin" });
    const token = readCookie(request, names.session);
    const resolved = token === undefined ? undefined : auth.resolve(token);
    if (!token || !resolved) throw new DeskmatesError("token_rejected", "not signed in");
    if (!allowWhilePasswordChangeRequired && auth.mustChangePassword(resolved.session))
      throw new DeskmatesError("forbidden", "change the initial password first", {
        reason: "password_change_required",
      });
    if (!sameSecret(headerValue(request, CSRF_HEADER), csrfTokenFor(token)))
      throw new DeskmatesError("forbidden", "missing or invalid CSRF token", { reason: "csrf" });
    return { token, resolved };
  };

  app.get("/auth/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const token = readCookie(request, names.session);
    // A tab names its tenant; a selector this session may not enter falls back to the default
    // choice rather than signing the tab out.
    const selected = headerValue(request, TENANT_HEADER);
    const resolved =
      token === undefined
        ? undefined
        : ((selected ? auth.resolve(token, selected) : undefined) ?? auth.resolve(token));
    if (token && resolved) return sessionView(resolved, token);
    const existing = readCookie(request, names.login);
    const loginCookie = existing && COOKIE_VALUE.test(existing) ? existing : newOpaqueToken();
    const cookies = [serializeCookie(names.login, loginCookie, mode, LOGIN_COOKIE_MAX_AGE_SECONDS)];
    // A dead session cookie is dropped so the browser stops presenting it.
    if (token) cookies.push(serializeCookie(names.session, "", mode, 0));
    reply.header("set-cookie", cookies);
    const view: AnonymousSessionView = {
      authenticated: false,
      setupRequired: auth.setupRequired(),
      loginCsrf: loginCsrfFor(loginCookie),
      ssoProviders: ctx.oidc.store
        .listProviders()
        .filter((provider) => provider.status === "active")
        .map((provider) => ({ id: provider.id, displayName: provider.displayName })),
    };
    return view;
  });

  /** A pre-login mutation: allowed Origin and the pre-login token of this browser's cookie. */
  const requireLoginCsrf = (request: FastifyRequest): string => {
    if (!originAllowed(request, auth.config.allowedOrigins))
      throw new DeskmatesError("forbidden", "cross-origin request refused", { reason: "origin" });
    const loginCookie = readCookie(request, names.login);
    if (
      !loginCookie ||
      !COOKIE_VALUE.test(loginCookie) ||
      !sameSecret(headerValue(request, CSRF_HEADER), loginCsrfFor(loginCookie))
    )
      throw new DeskmatesError("forbidden", "missing or invalid sign-in token; reload the page", {
        reason: "login_csrf",
      });
    return loginCookie;
  };

  /** Sign this browser in with a new session, ending the one it held before. */
  const replaceSession = (request: FastifyRequest, reply: FastifyReply, token: string): void => {
    const previous = readCookie(request, names.session);
    const previousResolved = previous === undefined ? undefined : auth.resolve(previous);
    if (previousResolved) auth.logout(previousResolved.session.id);
    setSessionCookie(reply, token);
  };

  app.post("/auth/login", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireLoginCsrf(request);
    const body = asRecord(request.body);
    const loginName = requiredString(body, "loginName", 256);
    const password = requiredString(body, "password", 1024);
    const opened = await auth.login(loginName, password, request.ip);
    const resolved = auth.resolve(opened.token);
    if (!resolved)
      throw new DeskmatesError("token_rejected", "Login name or password is incorrect");
    // Signing in again in this browser ends the session it held before.
    replaceSession(request, reply, opened.token);
    return sessionView(resolved, opened.token);
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { resolved } = requireSessionMutation(request, true);
    auth.logout(resolved.session.id);
    clearSessionCookie(reply);
    return { signedOut: true };
  });

  app.post("/auth/logout-all", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { resolved } = requireSessionMutation(request, true);
    const revoked = auth.logoutAll(resolved.principal.userId);
    clearSessionCookie(reply);
    return { signedOut: true, sessionsRevoked: revoked };
  });

  app.post("/auth/password", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { resolved } = requireSessionMutation(request, true);
    const body = asRecord(request.body);
    const rotated = await auth.changePassword(
      resolved.principal,
      requiredString(body, "currentPassword", 1024),
      requiredString(body, "newPassword", 1024),
    );
    const next = auth.resolve(rotated.token);
    if (!next) throw new DeskmatesError("token_rejected", "not signed in");
    setSessionCookie(reply, rotated.token);
    return sessionView(next, rotated.token);
  });

  // OIDC (ADR-0022 decision 3). Start is a CSRF-protected POST that returns the IdP URL; the
  // callback is a top-level GET from the IdP, authenticated by its single-use state and the
  // browser binding that start recorded.
  app.post("/auth/oidc/:provider/start", async (request) => {
    const body = asRecord(request.body);
    const purpose = body.purpose;
    if (purpose !== "login" && purpose !== "link" && purpose !== "tenant_grant")
      throw new DeskmatesError("validation", "purpose must be login, link or tenant_grant");
    const tenantId = body.tenantId;
    if (tenantId !== undefined && (typeof tenantId !== "string" || tenantId.length > 128))
      throw new DeskmatesError("validation", "tenantId must be a string");
    const providerId = (request.params as { provider: string }).provider;
    const common = {
      providerId,
      purpose: purpose as OidcPurpose,
      ...(tenantId !== undefined ? { tenantId } : {}),
      returnPath: body.returnPath,
    };
    const invitation = body.invitation;
    if (invitation !== undefined && (typeof invitation !== "string" || invitation.length > 256))
      throw new DeskmatesError("validation", "invitation must be a string");
    let started: OidcStartResponse;
    if (purpose === "login") {
      const loginCookie = requireLoginCsrf(request);
      const admitted = loginStarts.admit("oidc-start", request.ip);
      if ("retryAfterMs" in admitted)
        throw new DeskmatesError("rate_limited", "too many sign-in attempts from this address", {
          retryAfterSeconds: Math.ceil(admitted.retryAfterMs / 1000),
        });
      admitted.ticket.failed();
      started = await ctx.oidc.start({
        ...common,
        browserBinding: loginCookie,
        ...(invitation !== undefined ? { invitation } : {}),
      });
    } else {
      const { token, resolved } = requireSessionMutation(request);
      started = await ctx.oidc.start({
        ...common,
        session: resolved.session,
        browserBinding: token,
      });
    }
    return started;
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    reply.header("cache-control", "no-store");
    // The URL carries an authorization code; never leak it to the next page's requests.
    reply.header("referrer-policy", "no-referrer");
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query as Record<string, unknown>))
      if (typeof value === "string") query.append(key, value);
    try {
      const outcome = await ctx.oidc.callback(query, {
        loginCookie: readCookie(request, names.login),
        sessionToken: readCookie(request, names.session),
      });
      if (outcome.kind === "signed_in") replaceSession(request, reply, outcome.token);
      return reply.redirect(outcome.returnPath, 303);
    } catch (error) {
      if (!(error instanceof OidcFlowError)) throw error;
      request.log.info({ ssoFailure: error.failure }, "oidc callback refused");
      const target = new URL(error.returnPath, "http://return.invalid");
      target.searchParams.set(SSO_ERROR_PARAM, error.failure);
      return reply.redirect(`${target.pathname}${target.search}${target.hash}`, 303);
    }
  });

  // OpenID Connect Back-Channel Logout 1.0: the IdP posts a signed logout token, server to
  // server, as a form. No cookie or CSRF applies; the token's signature, issuer, audience, age,
  // event and one-time `jti` are the authentication (OidcService.backchannelLogout).
  app.register(async (logout) => {
    logout.removeAllContentTypeParsers();
    logout.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 32_768 },
      (_request, body, done) => done(null, new URLSearchParams(body as string)),
    );
    logout.post<{ Params: { provider: string } }>(
      "/auth/oidc/:provider/backchannel-logout",
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const form = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
        const token = form.get("logout_token") ?? "";
        try {
          const result = await ctx.oidc.backchannelLogout(request.params.provider, token);
          request.log.info({ ...result }, "oidc back-channel logout");
          return {};
        } catch (error) {
          // The spec's error shape; the reason stays in the log, not the response.
          if (error instanceof DeskmatesError && error.code === "validation") {
            request.log.info({ reason: error.message }, "oidc back-channel logout refused");
            return reply.code(400).send({ error: "invalid_request" });
          }
          throw error;
        }
      },
    );
  });

  // Invitations (ADR-0022 P4, amendment 4). The token in the link is the only input that selects
  // one. An unknown token, or one meant for another identity, gets the uniform 401; a known link
  // that was used, revoked or expired gets 410 with the reason, which only its holder can learn.
  app.get<{ Params: { token: string } }>("/auth/invitations/:token", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    const invitation = auth.openInvitation(request.params.token);
    const provider =
      invitation.providerId === null
        ? undefined
        : ctx.oidc.store.getProvider(invitation.providerId);
    const preview: InvitationPreview = {
      tenantName: auth.users.getTenant(invitation.tenantId)?.name ?? "",
      role: invitation.role,
      workspaceName: ctx.workspaces.get(invitation.workspaceId as WorkspaceId)?.name ?? "",
      target: invitationTarget(invitation),
      expiresAt: invitation.expiresAt,
      ...(provider ? { provider: { id: provider.id, displayName: provider.displayName } } : {}),
    };
    return preview;
  });

  app.post("/auth/invitations/accept", async (request, reply) => {
    reply.header("cache-control", "no-store");
    // Origin is checked first so a cross-site page cannot probe tokens through a browser.
    if (!originAllowed(request, auth.config.allowedOrigins))
      throw new DeskmatesError("forbidden", "cross-origin request refused", { reason: "origin" });
    const body = asRecord(request.body);
    const token = requiredString(body, "token", 256);
    const invitation = auth.openInvitation(token);
    // A new account: the pre-login CSRF token of this (signed-out) browser. For `local_signup`
    // the request names the chosen username; without one, a signed-in browser joins below.
    const newAccount =
      invitation.targetKind === "local_new" ||
      (invitation.targetKind === "local_signup" && body.loginName !== undefined);
    if (newAccount) {
      requireLoginCsrf(request);
      const opened =
        invitation.targetKind === "local_signup"
          ? await auth.acceptSignupInvitation(token, {
              loginName: requiredString(body, "loginName", 256),
              ...optionalDisplayName(body),
              password: requiredString(body, "password", 1024),
            })
          : await auth.acceptNewAccountInvitation(token, {
              ...optionalDisplayName(body),
              password: requiredString(body, "password", 1024),
            });
      const resolved = auth.resolve(opened.token, invitation.tenantId);
      if (!resolved)
        throw new DeskmatesError("token_rejected", "This invitation is not valid for this account");
      replaceSession(request, reply, opened.token);
      return sessionView(resolved, opened.token);
    }
    if (invitation.targetKind === "local_user" || invitation.targetKind === "local_signup") {
      const { resolved } = requireSessionMutation(request);
      auth.acceptExistingAccountInvitation(token, resolved.principal);
      return { joined: true, tenantId: invitation.tenantId };
    }
    throw new DeskmatesError(
      "validation",
      "accept this invitation by signing in with its provider",
      {
        reason: "use_sso",
      },
    );
  });
}

function optionalDisplayName(body: Record<string, unknown>): { displayName?: string } {
  const displayName = optionalBoundedString(body, "displayName", 512);
  return displayName === undefined ? {} : { displayName };
}

/** The public shape of an invitation's bound identity. */
export function invitationTarget(invitation: Invitation): InvitationTargetView {
  const value = invitation.targetValue ?? "";
  switch (invitation.targetKind) {
    case "local_signup":
      return { kind: "local_signup" };
    case "oidc_email":
      return { kind: "oidc_email", providerId: invitation.providerId ?? "", email: value };
    default:
      return { kind: invitation.targetKind, loginName: value };
  }
}
