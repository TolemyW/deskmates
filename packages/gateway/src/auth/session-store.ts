// Persistent, revocable browser sessions and their tenant grants (ADR-0022 decision 2). The
// database holds the SHA-256 of each session token and never the token, so a database copy does
// not sign anyone in. Every lookup re-reads revocation, expiry, user, membership and tenant
// state, which makes revocation effective on the next request without any cache to invalidate.

import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { hashToken, newOpaqueToken } from "./tokens.js";
import type { Tenant, TenantMembership, User, UserLogin, UserStore } from "./user-store.js";

export const SESSION_IDLE_TTL_SECONDS_DEFAULT = 7 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_TTL_SECONDS_DEFAULT = 30 * 24 * 60 * 60;
/** Sliding idle expiry is written at most this often, so reads do not become writes. */
const TOUCH_INTERVAL_MS = 60_000;

export type SessionRevokeReason =
  | "logout"
  | "logout_all"
  | "password_changed"
  | "user_disabled"
  | "maintenance"
  | "no_tenant"
  | "rotated"
  | "idp_logout";

export interface SessionTtl {
  idleSeconds: number;
  absoluteSeconds: number;
}

export interface AuthSession {
  id: string;
  userId: string;
  loginId: string;
  authMethod: "local" | "oidc";
  authenticatedAt: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  login_id: string;
  auth_method: "local" | "oidc";
  authenticated_at: string;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface GrantRow {
  id: string;
  session_id: string;
  tenant_id: string;
  login_id: string;
  provider: "local" | "oidc";
  issuer: string;
  policy_version: number;
  membership_auth_version: number;
  auth_time: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface TenantGrant {
  id: string;
  sessionId: string;
  tenantId: string;
  loginId: string;
  provider: "local" | "oidc";
  issuer: string;
  policyVersion: number;
  membershipAuthVersion: number;
  authTime: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Why a session cannot enter a tenant; never shown to the caller beyond a uniform 401/403. */
export type TenantAccessDenial =
  | "tenant_inactive"
  | "no_membership"
  | "membership_inactive"
  | "no_grant"
  | "grant_revoked"
  | "grant_expired"
  | "grant_policy_stale"
  | "grant_membership_stale"
  | "provider_not_allowed";

function toSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    loginId: row.login_id,
    authMethod: row.auth_method,
    authenticatedAt: row.authenticated_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function toGrant(row: GrantRow): TenantGrant {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    loginId: row.login_id,
    provider: row.provider,
    issuer: row.issuer,
    policyVersion: row.policy_version,
    membershipAuthVersion: row.membership_auth_version,
    authTime: row.auth_time,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** Issuers a tenant trusts for SSO, each with its maximum authentication age in seconds. */
export type TenantSsoIssuers = ReadonlyMap<string, number>;

/**
 * Whether evidence from this login may enter a tenant with this policy, and for how long after
 * the authentication. `sso_required` admits only an OIDC login from an issuer the tenant links,
 * and then only within that provider's maximum authentication age; a local login, another
 * tenant's issuer or a matching email is never a substitute (ADR-0022 decision 3). The other
 * policies admit any proven login without an extra age bound.
 */
export function loginAdmitsTenant(
  login: { provider: "local" | "oidc"; issuer: string },
  policy: Tenant["authPolicy"],
  ssoIssuers: TenantSsoIssuers,
): { maxAuthAgeSeconds?: number } | undefined {
  if (policy !== "sso_required") return {};
  const age = login.provider === "oidc" ? ssoIssuers.get(login.issuer) : undefined;
  return age === undefined ? undefined : { maxAuthAgeSeconds: age };
}

/** The one decision every request makes: may this session act in this tenant right now? */
export function evaluateTenantAccess(input: {
  tenant: Tenant | undefined;
  membership: TenantMembership | undefined;
  grant: TenantGrant | undefined;
  /** The tenant's linked SSO issuers now; only an `sso_required` tenant needs them. */
  ssoIssuers?: TenantSsoIssuers;
  now: Date;
}): { ok: true } | { ok: false; reason: TenantAccessDenial } {
  const { tenant, membership, grant, now } = input;
  if (!tenant || tenant.status !== "active") return { ok: false, reason: "tenant_inactive" };
  if (!membership) return { ok: false, reason: "no_membership" };
  if (membership.status !== "active") return { ok: false, reason: "membership_inactive" };
  if (!grant) return { ok: false, reason: "no_grant" };
  if (grant.revokedAt !== null) return { ok: false, reason: "grant_revoked" };
  if (Date.parse(grant.expiresAt) <= now.getTime()) return { ok: false, reason: "grant_expired" };
  if (grant.policyVersion !== tenant.authPolicyVersion)
    return { ok: false, reason: "grant_policy_stale" };
  if (grant.membershipAuthVersion !== membership.authVersion)
    return { ok: false, reason: "grant_membership_stale" };
  const admitted = loginAdmitsTenant(grant, tenant.authPolicy, input.ssoIssuers ?? new Map());
  if (!admitted) return { ok: false, reason: "provider_not_allowed" };
  // The age bound is re-read from the tenant's current link, so shortening it applies at once.
  if (
    admitted.maxAuthAgeSeconds !== undefined &&
    Date.parse(grant.authTime) + admitted.maxAuthAgeSeconds * 1000 <= now.getTime()
  )
    return { ok: false, reason: "grant_expired" };
  return { ok: true };
}

export class SessionStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly users: UserStore,
    private readonly ttl: SessionTtl,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Open a fresh session for a verified login and grant it every tenant whose policy accepts
   * this login. The token is new random bytes on every call: nothing the client sent before
   * sign-in can become a session (fixation). `authTime` is when the login was proven (the IdP's
   * `auth_time` for OIDC); it defaults to now.
   */
  create(
    user: User,
    login: UserLogin,
    authTime: Date = this.clock(),
    /** The IdP session (`sid` claim) an OIDC sign-in came from, for back-channel logout. */
    idpSid: string | null = null,
  ): { token: string; session: AuthSession } {
    const now = this.clock();
    const at = now.toISOString();
    const absolute = new Date(now.getTime() + this.ttl.absoluteSeconds * 1000);
    const idle = new Date(
      Math.min(now.getTime() + this.ttl.idleSeconds * 1000, absolute.getTime()),
    );
    const token = newOpaqueToken();
    const id = newId("ses");
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO auth_sessions (id, token_hash, user_id, login_id, auth_method,
               authenticated_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
               idp_sid)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            hashToken(token),
            user.id,
            login.id,
            login.provider,
            authTime.toISOString(),
            at,
            at,
            idle.toISOString(),
            absolute.toISOString(),
            idpSid,
          );
        for (const membership of this.users.activeMemberships(user.id))
          this.issueGrantIn(id, membership.tenantId, login, authTime, absolute, idpSid);
      })
      .immediate();
    return { token, session: this.get(id) as AuthSession };
  }

  /**
   * Grant a live session one tenant on fresh login evidence (an SSO step-up). Replaces any
   * earlier grant of the session for that tenant. Returns the grant, or undefined when the
   * tenant's policy does not accept this login or the user is not an active member.
   */
  issueGrant(
    sessionId: string,
    tenantId: string,
    login: UserLogin,
    authTime: Date,
    idpSid: string | null = null,
  ): TenantGrant | undefined {
    return this.db
      .transaction(() => {
        const session = this.get(sessionId);
        if (!session || !this.isLive(session) || session.userId !== login.userId) return undefined;
        const issued = this.issueGrantIn(
          sessionId,
          tenantId,
          login,
          authTime,
          new Date(Date.parse(session.absoluteExpiresAt)),
          idpSid,
        );
        return issued ? this.grant(sessionId, tenantId) : undefined;
      })
      .immediate();
  }

  private issueGrantIn(
    sessionId: string,
    tenantId: string,
    login: UserLogin,
    authTime: Date,
    absolute: Date,
    idpSid: string | null,
  ): boolean {
    const tenant = this.users.getTenant(tenantId);
    const membership = this.users.getMembership(tenantId, login.userId);
    if (!tenant || tenant.status !== "active" || membership?.status !== "active") return false;
    const admitted = loginAdmitsTenant(
      login,
      tenant.authPolicy,
      this.users.tenantSsoIssuers(tenantId),
    );
    if (!admitted) return false;
    const expires =
      admitted.maxAuthAgeSeconds === undefined
        ? absolute.getTime()
        : Math.min(absolute.getTime(), authTime.getTime() + admitted.maxAuthAgeSeconds * 1000);
    const at = this.clock().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_auth_grants (id, session_id, tenant_id, login_id, provider,
           issuer, policy_version, membership_auth_version, auth_time, expires_at, created_at,
           idp_sid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, tenant_id) DO UPDATE SET login_id = excluded.login_id,
           idp_sid = excluded.idp_sid,
           provider = excluded.provider, issuer = excluded.issuer,
           policy_version = excluded.policy_version,
           membership_auth_version = excluded.membership_auth_version,
           auth_time = excluded.auth_time, expires_at = excluded.expires_at, revoked_at = NULL,
           created_at = excluded.created_at`,
      )
      .run(
        newId("tgr"),
        sessionId,
        tenant.id,
        login.id,
        login.provider,
        login.issuer,
        tenant.authPolicyVersion,
        membership.authVersion,
        authTime.toISOString(),
        new Date(expires).toISOString(),
        at,
        idpSid,
      );
    return true;
  }

  get(id: string): AuthSession | undefined {
    const row = this.db.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row ? toSession(row) : undefined;
  }

  /** Whether a session is still live: not revoked, not expired, its user still active. */
  isLive(session: AuthSession): boolean {
    const now = this.clock().getTime();
    if (session.revokedAt !== null) return false;
    if (Date.parse(session.idleExpiresAt) <= now) return false;
    if (Date.parse(session.absoluteExpiresAt) <= now) return false;
    return this.users.getUser(session.userId)?.status === "active";
  }

  /** Resolve a presented token to a live session and slide its idle expiry; undefined otherwise. */
  authenticate(token: string): AuthSession | undefined {
    if (token.length === 0 || token.length > 256) return undefined;
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE token_hash = ?")
      .get(hashToken(token)) as SessionRow | undefined;
    if (!row) return undefined;
    const session = toSession(row);
    if (!this.isLive(session)) return undefined;
    const now = this.clock();
    if (now.getTime() - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS) {
      const idle = new Date(
        Math.min(
          now.getTime() + this.ttl.idleSeconds * 1000,
          Date.parse(session.absoluteExpiresAt),
        ),
      ).toISOString();
      this.db
        .prepare(
          "UPDATE auth_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(now.toISOString(), idle, session.id);
      return { ...session, lastSeenAt: now.toISOString(), idleExpiresAt: idle };
    }
    return session;
  }

  grant(sessionId: string, tenantId: string): TenantGrant | undefined {
    const row = this.db
      .prepare("SELECT * FROM tenant_auth_grants WHERE session_id = ? AND tenant_id = ?")
      .get(sessionId, tenantId) as GrantRow | undefined;
    return row ? toGrant(row) : undefined;
  }

  /** Revoke one session; returns whether it was live before. Idempotent. */
  revoke(sessionId: string, reason: SessionRevokeReason): boolean {
    const at = this.clock().toISOString();
    return this.db
      .transaction(() => {
        const result = this.db
          .prepare(
            "UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL",
          )
          .run(at, reason, sessionId);
        this.db
          .prepare(
            "UPDATE tenant_auth_grants SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
          )
          .run(at, sessionId);
        return result.changes > 0;
      })
      .immediate();
  }

  /** Revoke every live session of a user, optionally keeping one; returns the revoked ids. */
  revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    exceptSessionId?: string,
  ): string[] {
    return this.db
      .transaction(() => {
        const ids = (
          this.db
            .prepare(
              "SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?",
            )
            .all(userId, exceptSessionId ?? null) as Array<{ id: string }>
        ).map((row) => row.id);
        for (const id of ids) this.revoke(id, reason);
        return ids;
      })
      .immediate();
  }

  /**
   * Back-channel logout (ADR-0022 decision 3): end what one IdP user (`sub`) or one IdP session
   * (`sid`) of `issuer` established. Sessions signed in that way are revoked; step-up grants
   * issued that way are revoked without ending the session they were added to.
   * Returns the revoked session ids and the sessions that lost a grant.
   */
  revokeForIdpLogout(
    issuer: string,
    sub: string | undefined,
    sid: string | undefined,
  ): { sessions: string[]; grantSessions: string[] } {
    if (sub === undefined && sid === undefined) return { sessions: [], grantSessions: [] };
    const at = this.clock().toISOString();
    const logins = `login_id IN (SELECT id FROM user_logins WHERE provider = 'oidc' AND issuer = ?${
      sub === undefined ? "" : " AND subject = ?"
    })`;
    const bySid = sid === undefined ? "" : " AND idp_sid = ?";
    const args = [issuer, ...(sub === undefined ? [] : [sub]), ...(sid === undefined ? [] : [sid])];
    return this.db
      .transaction(() => {
        const sessions = (
          this.db
            .prepare(`SELECT id FROM auth_sessions WHERE revoked_at IS NULL AND ${logins}${bySid}`)
            .all(...args) as Array<{ id: string }>
        ).map((row) => row.id);
        for (const id of sessions) this.revoke(id, "idp_logout");
        const grantSessions = (
          this.db
            .prepare(
              `SELECT DISTINCT session_id AS id FROM tenant_auth_grants
               WHERE revoked_at IS NULL AND ${logins}${bySid}`,
            )
            .all(...args) as Array<{ id: string }>
        ).map((row) => row.id);
        this.db
          .prepare(
            `UPDATE tenant_auth_grants SET revoked_at = ?
             WHERE revoked_at IS NULL AND ${logins}${bySid}`,
          )
          .run(at, ...args);
        return { sessions, grantSessions };
      })
      .immediate();
  }

  /** Sessions of a tenant's grants; used to close live connections after a membership change. */
  sessionIdsWithGrant(tenantId: string, userId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT g.session_id AS id FROM tenant_auth_grants g
           JOIN auth_sessions s ON s.id = g.session_id
           WHERE g.tenant_id = ? AND s.user_id = ? AND g.revoked_at IS NULL AND s.revoked_at IS NULL`,
        )
        .all(tenantId, userId) as Array<{ id: string }>
    ).map((row) => row.id);
  }
}
