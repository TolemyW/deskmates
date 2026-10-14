// Generic OIDC sign-in, identity linking and tenant SSO step-up (ADR-0022 decision 3), on the
// maintained `openid-client` library: authorization code + PKCE (S256), one-time state, nonce,
// exact registered redirect URI, signature/JWKS, issuer, audience and expiry checks. Discovery is
// fetched only from a provider's pinned issuer. A person is identified by issuer + subject; an
// email claim is stored for display and never used to find or merge an account.

import { timingSafeEqual } from "node:crypto";
import { DeskmatesError } from "@deskmates/contracts";
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import * as oidc from "openid-client";
import type { AuthService } from "./auth-service.js";
import {
  type OidcProvider,
  type OidcPurpose,
  type OidcStore,
  type OidcTransaction,
  safeReturnPath,
} from "./oidc-store.js";
import type { AuthSession } from "./session-store.js";
import { hashToken } from "./tokens.js";
import type { UserLogin } from "./user-store.js";

/** A signed-in session may link a new identity only this soon after it authenticated. */
export const LINK_RECENT_AUTH_SECONDS = 10 * 60;
const DISCOVERY_TIMEOUT_SECONDS = 10;

/**
 * Why a callback failed. The code goes back to the browser as `?sso_error=`; it names the step,
 * never the claim or token that failed, so it cannot be used to probe accounts or keys.
 */
export type OidcFailure =
  | "invalid_state"
  | "not_signed_in"
  | "provider_unavailable"
  | "idp_error"
  | "rejected"
  | "no_account"
  | "no_tenant"
  | "identity_in_use"
  | "not_linked"
  | "not_allowed"
  | "invitation_invalid";

export class OidcFlowError extends Error {
  constructor(
    readonly failure: OidcFailure,
    readonly returnPath: string = "/",
  ) {
    super(`oidc ${failure}`);
  }
}

export type OidcOutcome =
  | { kind: "signed_in"; token: string; session: AuthSession; returnPath: string }
  | { kind: "linked"; login: UserLogin; returnPath: string }
  | { kind: "granted"; tenantId: string; returnPath: string };

export interface OidcStartInput {
  providerId: string;
  purpose: OidcPurpose;
  tenantId?: string;
  /** For `link` and `tenant_grant`: the signed-in session starting the flow. */
  session?: AuthSession;
  /** Secret only this browser holds: the pre-login cookie, or the session token. */
  browserBinding: string;
  returnPath?: unknown;
  /** For `login`: an `oidc_email` invitation token for this provider (P4). */
  invitation?: string;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

/** The IdP session id an ID token names, if any (OpenID Connect Front/Back-Channel Logout). */
function idpSid(claims: oidc.IDToken): string | null {
  return typeof claims.sid === "string" && claims.sid.length > 0 && claims.sid.length <= 255
    ? claims.sid
    : null;
}

const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
/** A logout token older than this is refused; its `jti` is remembered at least this long. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 5 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;

export class OidcService {
  private readonly configurations = new Map<string, Promise<oidc.Configuration>>();

  constructor(
    readonly store: OidcStore,
    private readonly auth: AuthService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Discovery for one provider, cached per process. A failure is not cached, so an IdP outage
   * fails closed now and recovers on a later attempt. Plain HTTP is only ever used for a
   * loopback issuer, which `OidcStore.addProvider` is the only way to register.
   */
  private configuration(provider: OidcProvider): Promise<oidc.Configuration> {
    const key = `${provider.id}\u0000${provider.issuer}\u0000${provider.clientId}`;
    const cached = this.configurations.get(key);
    if (cached) return cached;
    const secret = this.store.clientSecret(provider);
    const issuer = new URL(provider.issuer);
    const pending = oidc
      .discovery(
        issuer,
        provider.clientId,
        { redirect_uris: [provider.redirectUri] },
        secret === undefined ? oidc.None() : oidc.ClientSecretPost(secret),
        {
          timeout: DISCOVERY_TIMEOUT_SECONDS,
          // The library skips the ID token signature for a token-endpoint response by default
          // (OIDC Core 3.1.3.7 permits it over TLS). ADR-0022 requires the JWKS check anyway,
          // so a compromised or spoofed token endpoint cannot mint an identity.
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(isLoopbackHttp(issuer) ? [oidc.allowInsecureRequests] : []),
          ],
        },
      )
      .catch((error: unknown) => {
        this.configurations.delete(key);
        throw error;
      });
    this.configurations.set(key, pending);
    return pending;
  }

  private readonly jwks = new Map<string, JWTVerifyGetKey>();

  /** Forget cached discovery and keys, e.g. after a provider changes or in tests. */
  forget(): void {
    this.configurations.clear();
    this.jwks.clear();
  }

  /**
   * OpenID Connect Back-Channel Logout 1.0, section 2.6: validate a logout token from a
   * provider's IdP and end what it names. The token must be signed by a key in the provider's
   * JWKS, issued by its pinned issuer for this client, recent, carry the back-channel logout
   * event, a `sub` or `sid`, no `nonce`, and a `jti` not seen before. A token for a user or IdP
   * session the Gateway does not know is accepted and changes nothing.
   */
  async backchannelLogout(
    providerId: string,
    logoutToken: string,
  ): Promise<{ sessionsRevoked: number; grantsRevoked: number }> {
    const provider = this.store.getProvider(providerId);
    if (!provider || provider.status !== "active")
      throw new DeskmatesError("not_found", "Not found");
    if (logoutToken.length === 0 || logoutToken.length > 16_384)
      throw new DeskmatesError("validation", "invalid logout token");
    let config: oidc.Configuration;
    try {
      config = await this.configuration(provider);
    } catch {
      throw new DeskmatesError("integration_unavailable", "The sign-in provider is unavailable");
    }
    const metadata = config.serverMetadata();
    if (!metadata.jwks_uri) throw new DeskmatesError("validation", "provider publishes no keys");
    let keys = this.jwks.get(provider.id);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(metadata.jwks_uri));
      this.jwks.set(provider.id, keys);
    }
    const now = this.clock();
    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(logoutToken, keys, {
        issuer: metadata.issuer,
        audience: provider.clientId,
        currentDate: now,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SECONDS,
        requiredClaims: ["iat", "jti"],
        // Never `none`, never a symmetric key derived from a secret the IdP and others share.
        algorithms: [
          "RS256",
          "RS384",
          "RS512",
          "PS256",
          "PS384",
          "PS512",
          "ES256",
          "ES384",
          "ES512",
          "EdDSA",
        ],
      });
      payload = verified.payload as Record<string, unknown>;
      const typ = verified.protectedHeader.typ;
      if (typ !== undefined && typ.toLowerCase() !== "logout+jwt") throw new Error("typ");
    } catch {
      throw new DeskmatesError("validation", "invalid logout token");
    }
    const events = payload.events;
    const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
    const sid = typeof payload.sid === "string" && payload.sid.length > 0 ? payload.sid : undefined;
    if (
      !events ||
      typeof events !== "object" ||
      typeof (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT] !== "object" ||
      "nonce" in payload ||
      (sub === undefined && sid === undefined) ||
      typeof payload.jti !== "string"
    )
      throw new DeskmatesError("validation", "invalid logout token");
    if (!this.store.rememberLogoutToken(provider.id, payload.jti, LOGOUT_TOKEN_MAX_AGE_SECONDS * 2))
      throw new DeskmatesError("validation", "logout token already used");
    // `sub` names one login of this issuer; `sid` alone names an IdP session of any of its users.
    const revoked = this.auth.sessions.revokeForIdpLogout(provider.issuer, sub, sid);
    this.auth.live.closeSessions(revoked.sessions);
    // A session that only lost a step-up keeps its other tenants; its streams there stay open.
    this.auth.live.sweep();
    return {
      sessionsRevoked: revoked.sessions.length,
      grantsRevoked: revoked.grantSessions.length,
    };
  }

  /** Begin a flow; returns the IdP authorization URL the browser should open. */
  async start(input: OidcStartInput): Promise<{ authorizationUrl: string }> {
    const provider = this.store.getProvider(input.providerId);
    if (!provider || provider.status !== "active")
      throw new DeskmatesError("not_found", "Not found");
    const returnPath = safeReturnPath(input.returnPath);
    let tenantId: string | null = null;
    let maxAge: number | undefined;
    let invitationId: string | null = null;
    if (input.invitation !== undefined) {
      const invitation = this.auth.invitations.open(input.invitation);
      if (
        input.purpose !== "login" ||
        !invitation ||
        invitation.targetKind !== "oidc_email" ||
        invitation.providerId !== provider.id
      )
        throw new DeskmatesError("token_rejected", "This invitation is not valid for this account");
      invitationId = invitation.id;
      tenantId = invitation.tenantId;
    } else if (input.purpose === "login") {
      if (input.tenantId !== undefined) {
        // Only a tenant that trusts this provider can be a JIT target.
        if (!this.store.tenantLink(input.tenantId, provider.id))
          throw new DeskmatesError("not_found", "Not found");
        tenantId = input.tenantId;
      } else {
        // The sign-in page names no tenant. When exactly one active tenant admits unknown
        // subjects of this provider (`--jit member`), the sign-in is for that tenant. This grants
        // nothing a client could not ask for by naming the tenant, since tenant ids are not
        // secrets; with several such tenants the target is ambiguous and an invitation decides.
        const jit = this.store.jitTenants(provider.id);
        if (jit.length === 1) tenantId = jit[0] ?? null;
      }
    } else {
      const session = input.session;
      if (!session) throw new DeskmatesError("token_rejected", "not signed in");
      if (input.purpose === "link") {
        const age = this.clock().getTime() - Date.parse(session.authenticatedAt);
        if (age > LINK_RECENT_AUTH_SECONDS * 1000)
          throw new DeskmatesError("forbidden", "sign in again before linking an identity", {
            reason: "reauth_required",
          });
      } else {
        if (input.tenantId === undefined)
          throw new DeskmatesError("validation", "tenantId is required");
        const membership = this.auth.users.getMembership(input.tenantId, session.userId);
        const link = this.store.tenantLink(input.tenantId, provider.id);
        if (membership?.status !== "active" || !link)
          throw new DeskmatesError("not_found", "Not found");
        tenantId = input.tenantId;
        maxAge = link.maxAuthAgeSeconds;
      }
    }
    const config = await this.configuration(provider).catch(() => {
      throw new DeskmatesError("integration_unavailable", "The sign-in provider is unavailable");
    });
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    const state = this.store.createTransaction({
      providerId: provider.id,
      purpose: input.purpose,
      tenantId,
      sessionId: input.session?.id ?? null,
      browserBindingHash: hashToken(input.browserBinding),
      codeVerifier,
      nonce,
      returnPath,
      invitationId,
    });
    const parameters: Record<string, string> = {
      redirect_uri: provider.redirectUri,
      scope: provider.scopes,
      response_type: "code",
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    };
    // Linking needs fresh proof of the external identity; a step-up needs it within the tenant's
    // age bound.
    if (input.purpose === "link") parameters.prompt = "login";
    if (maxAge !== undefined) parameters.max_age = String(maxAge);
    return { authorizationUrl: oidc.buildAuthorizationUrl(config, parameters).href };
  }

  /**
   * Finish a flow from the callback's query string. `browser` carries the secrets this browser
   * holds; the transaction must have been started by the same browser (and, for link and
   * step-up, by the same live session).
   */
  async callback(
    query: URLSearchParams,
    browser: { loginCookie?: string | undefined; sessionToken?: string | undefined },
  ): Promise<OidcOutcome> {
    const state = query.get("state") ?? "";
    const transaction = this.store.consumeTransaction(state);
    if (!transaction) throw new OidcFlowError("invalid_state");
    const fail = (failure: OidcFailure): never => {
      throw new OidcFlowError(failure, transaction.returnPath);
    };
    const binding = transaction.purpose === "login" ? browser.loginCookie : browser.sessionToken;
    if (!binding || !sameHash(hashToken(binding), transaction.browserBindingHash))
      return fail("invalid_state");
    let session: AuthSession | undefined;
    if (transaction.purpose !== "login") {
      session = this.auth.sessions.authenticate(binding);
      if (!session || session.id !== transaction.sessionId) return fail("not_signed_in");
    }
    if (query.has("error")) return fail("idp_error");
    const provider = this.store.getProvider(transaction.providerId);
    if (!provider || provider.status !== "active") return fail("provider_unavailable");
    let config: oidc.Configuration;
    try {
      config = await this.configuration(provider);
    } catch {
      return fail("provider_unavailable");
    }
    const claims = await this.exchange(config, provider, query, state, transaction).catch(
      (error: unknown) => {
        if (error instanceof OidcFlowError) throw error;
        return fail("rejected");
      },
    );
    const identity = {
      issuer: provider.issuer,
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email.slice(0, 320) : null,
      emailVerified: claims.email_verified === true,
    };
    const now = this.clock();
    // The IdP's own authentication time bounds the grant; a claim in the future counts as now.
    // Without the claim the age is unknown and counts as the epoch: no `sso_required` grant
    // outlives it, and a step-up (which asks for `max_age`, so the claim is required) is needed.
    const authTime =
      typeof claims.auth_time === "number"
        ? new Date(Math.min(claims.auth_time * 1000, now.getTime()))
        : new Date(0);
    switch (transaction.purpose) {
      case "login":
        return this.finishLogin(transaction, identity, claims, authTime);
      case "link": {
        let login: UserLogin;
        try {
          login = this.auth.users.addOidcLogin((session as AuthSession).userId, identity);
        } catch {
          return fail("identity_in_use");
        }
        // Adding a sign-in method ends the user's other sessions (ADR-0022 decision 2).
        const revoked = this.auth.sessions.revokeAllForUser(
          login.userId,
          "rotated",
          (session as AuthSession).id,
        );
        this.auth.live.closeSessions(revoked);
        return { kind: "linked", login, returnPath: transaction.returnPath };
      }
      case "tenant_grant": {
        // A step-up exists to prove a recent IdP authentication; without auth_time it cannot.
        if (typeof claims.auth_time !== "number") return fail("rejected");
        const login = this.auth.users.findLogin("oidc", identity.issuer, identity.subject);
        if (!login || login.userId !== (session as AuthSession).userId) return fail("not_linked");
        const tenantId = transaction.tenantId as string;
        const grant = this.auth.sessions.issueGrant(
          (session as AuthSession).id,
          tenantId,
          login,
          authTime,
          idpSid(claims),
        );
        if (!grant) return fail("not_allowed");
        return { kind: "granted", tenantId, returnPath: transaction.returnPath };
      }
    }
  }

  private async exchange(
    config: oidc.Configuration,
    provider: OidcProvider,
    query: URLSearchParams,
    state: string,
    transaction: OidcTransaction,
  ): Promise<oidc.IDToken> {
    // The callback URL is rebuilt from the registered redirect URI, never from the request's
    // Host, so a proxy or forged Host header cannot change what the IdP is told.
    const current = new URL(provider.redirectUri);
    for (const [key, value] of query) current.searchParams.append(key, value);
    const maxAge =
      transaction.purpose === "tenant_grant" && transaction.tenantId !== null
        ? this.store.tenantLink(transaction.tenantId, provider.id)?.maxAuthAgeSeconds
        : undefined;
    const tokens = await oidc.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
      ...(maxAge !== undefined ? { maxAge } : {}),
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string" || claims.sub.length === 0)
      throw new OidcFlowError("rejected", transaction.returnPath);
    return claims;
  }

  private finishLogin(
    transaction: OidcTransaction,
    identity: { issuer: string; subject: string; email: string | null; emailVerified: boolean },
    claims: oidc.IDToken,
    authTime: Date,
  ): OidcOutcome {
    const fail = (failure: OidcFailure): never => {
      throw new OidcFlowError(failure, transaction.returnPath);
    };
    const users = this.auth.users;
    let login = users.findLogin("oidc", identity.issuer, identity.subject);
    if (transaction.invitationId) {
      // An invitation admits exactly the identity whose IdP asserts the invited email as
      // verified. An unverified or different email leaves the invitation unspent.
      const invitation = this.auth.invitations.openById(transaction.invitationId);
      if (
        !invitation ||
        invitation.providerId !== transaction.providerId ||
        !identity.emailVerified ||
        identity.email?.toLowerCase() !== invitation.targetValue
      )
        return fail("invitation_invalid");
      try {
        this.auth.db
          .transaction(() => {
            if (!login) {
              const name =
                typeof claims.name === "string" ? claims.name : (identity.email ?? "SSO user");
              const created = users.createOidcUser({
                ...identity,
                displayName: name,
                tenantId: invitation.tenantId,
                role: invitation.role,
                workspaceId: invitation.workspaceId,
              });
              login = created.login;
              if (!this.auth.invitations.consume(invitation.id, created.user.id))
                throw new Error("spent");
            } else {
              this.auth.joinTenant(invitation, login.userId);
            }
          })
          .immediate();
      } catch {
        return fail("invitation_invalid");
      }
    }
    if (!login) {
      // Just-in-time only for the tenant the flow was started for, only if that tenant allows it
      // for this provider, and only ever as a Member.
      const link =
        transaction.tenantId === null
          ? undefined
          : this.store.tenantLink(transaction.tenantId, transaction.providerId);
      const tenant =
        transaction.tenantId === null ? undefined : users.getTenant(transaction.tenantId);
      if (link?.jitRole !== "member" || tenant?.status !== "active") return fail("no_account");
      const name = typeof claims.name === "string" ? claims.name : (identity.email ?? "SSO user");
      try {
        login = users.createOidcUser({
          ...identity,
          displayName: name,
          tenantId: tenant.id,
        }).login;
      } catch {
        return fail("no_account");
      }
    }
    const user = users.getUser(login.userId);
    if (!user || user.status !== "active") return fail("no_account");
    const opened = this.auth.sessions.create(user, login, authTime, idpSid(claims));
    if (this.auth.enterableTenants(opened.session).length === 0) {
      this.auth.sessions.revoke(opened.session.id, "no_tenant");
      return fail("no_tenant");
    }
    return { kind: "signed_in", ...opened, returnPath: transaction.returnPath };
  }
}
