// Composition of the P1 login pieces: password verification with throttling, session creation,
// per-request resolution to a principal, logout, logout-all, password change and the platform
// maintenance operations the CLI calls. One instance per Gateway process (and one per CLI run).

import {
  DeskmatesError,
  type IssuedServicePrincipalView,
  type TenantRole,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { WorkspaceMembershipStore } from "../workspaces/memberships.js";
import type { CookieMode } from "./cookies.js";
import {
  type Invitation,
  type InvitationRole,
  InvitationStore,
  type InvitationTarget,
} from "./invitations.js";
import { LIVE_SWEEP_MS_DEFAULT, LiveConnections } from "./live-connections.js";
import { LOGIN_THROTTLE_DEFAULTS, LoginThrottle, type ThrottleLimits } from "./login-throttle.js";
import {
  ARGON2_DEFAULTS,
  type Argon2Params,
  PASSWORD_MIN_LENGTH,
  PasswordHasher,
  generateInitialPassword,
  passwordProblem,
} from "./passwords.js";
import type { ServicePrincipal, UserPrincipal } from "./principal.js";
import { normalizeDisplayName } from "./profile.js";
import {
  type ServicePrincipalRecord,
  ServicePrincipalStore,
  servicePrincipalView,
} from "./service-principals.js";
import {
  type AuthSession,
  SESSION_ABSOLUTE_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  SessionStore,
  evaluateTenantAccess,
} from "./session-store.js";
import { DEFAULT_TENANT_ID, type User, UserStore, normalizeLoginName } from "./user-store.js";

/** Deployment settings; every field has a reviewed-by-ADR default (ADR-0022 Verification 2). */
export interface AuthConfig {
  cookieMode: CookieMode;
  sessionIdleTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  /**
   * Origins allowed to send cookie-authenticated mutations, e.g. `https://deskmates.example`.
   * Empty means same-origin: the request's Origin must name the Host it was sent to.
   */
  allowedOrigins: string[];
  argon2: Argon2Params;
  /** Shortest accepted password (`GATEWAY_PASSWORD_MIN_LENGTH`); the maximum is fixed. */
  passwordMinLength: number;
  throttle: ThrottleLimits;
  liveSweepMs: number;
}

export const AUTH_CONFIG_DEFAULTS: Readonly<AuthConfig> = {
  cookieMode: "secure",
  sessionIdleTtlSeconds: SESSION_IDLE_TTL_SECONDS_DEFAULT,
  sessionAbsoluteTtlSeconds: SESSION_ABSOLUTE_TTL_SECONDS_DEFAULT,
  allowedOrigins: [],
  argon2: ARGON2_DEFAULTS,
  passwordMinLength: PASSWORD_MIN_LENGTH,
  throttle: LOGIN_THROTTLE_DEFAULTS,
  liveSweepMs: LIVE_SWEEP_MS_DEFAULT,
};

export function resolveAuthConfig(partial: Partial<AuthConfig> | undefined): AuthConfig {
  return { ...AUTH_CONFIG_DEFAULTS, ...(partial ?? {}) };
}

/** One answer for an unknown invitation, or one meant for another identity. */
function invitationRejected(): DeskmatesError {
  return new DeskmatesError("token_rejected", "This invitation is not valid for this account");
}

/** A known link that was used, revoked or expired (ADR-0022 amendment 4 I6). */
function invitationUnusable(reason: "used" | "revoked" | "expired"): DeskmatesError {
  const message = {
    used: "This invitation has already been used",
    revoked: "This invitation was revoked",
    expired: "This invitation has expired",
  }[reason];
  return new DeskmatesError("invitation_unusable", message, { reason });
}

function loginNameTaken(): DeskmatesError {
  return new DeskmatesError("invalid_transition", "That username is already taken", {
    reason: "login_name_taken",
  });
}

function ssoRequired(): DeskmatesError {
  return new DeskmatesError(
    "forbidden",
    "This team requires single sign-on; invite people with their SSO email instead",
    { reason: "sso_required" },
  );
}

/** Live-connection keys of service principals; session ids (`ses_...`) never start with it. */
const SERVICE_LIVE_PREFIX = "service:";

function serviceLiveKey(id: string, tokenHash: string): string {
  return `${SERVICE_LIVE_PREFIX}${id}:${tokenHash}`;
}

/** One message for every sign-in failure, so the response never says which part was wrong. */
const LOGIN_REJECTED = "Login name or password is incorrect";

/** The protected root account's login and default password (ADR-0031 decision 8, Q6). */
export const PROTECTED_ROOT_LOGIN = "admin";
const PROTECTED_ROOT_DEFAULT_PASSWORD = "admin";

/** The password operations the service needs; `PasswordHasher` in production. */
export type PasswordVerifier = Pick<PasswordHasher, "hash" | "verify" | "verifyAgainstNothing">;

export interface ResolvedSession {
  session: AuthSession;
  principal: UserPrincipal;
}

export class AuthService {
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly invitations: InvitationStore;
  readonly servicePrincipals: ServicePrincipalStore;
  /** A person's role per workspace (ADR-0031 decision 7). */
  readonly memberships: WorkspaceMembershipStore;
  readonly live: LiveConnections;
  readonly config: AuthConfig;
  private readonly hasher: PasswordVerifier;
  private readonly throttle: LoginThrottle;

  constructor(
    readonly db: GatewayDb,
    config: Partial<AuthConfig> | undefined,
    private readonly clock: () => Date = () => new Date(),
    /** Tests substitute a verifier whose result they release, to order races deterministically. */
    deps: { hasher?: PasswordVerifier } = {},
  ) {
    this.config = resolveAuthConfig(config);
    this.users = new UserStore(db, clock);
    this.memberships = new WorkspaceMembershipStore(db);
    this.invitations = new InvitationStore(db, clock);
    this.servicePrincipals = new ServicePrincipalStore(db, clock);
    this.sessions = new SessionStore(
      db,
      this.users,
      {
        idleSeconds: this.config.sessionIdleTtlSeconds,
        absoluteSeconds: this.config.sessionAbsoluteTtlSeconds,
      },
      clock,
    );
    this.hasher = deps.hasher ?? new PasswordHasher(this.config.argon2);
    this.throttle = new LoginThrottle(this.config.throttle, clock);
    this.live = new LiveConnections(
      (sessionId, tenantId) => this.sessionStillAuthorized(sessionId, tenantId),
      this.config.liveSweepMs,
    );
  }

  /** True until the first account exists; the UI then tells the visitor to ask maintenance. */
  setupRequired(): boolean {
    return this.users.userCount() === 0;
  }

  /**
   * Verify a local login and open a session. Unknown names, wrong passwords, disabled accounts
   * and accounts with no tenant to enter all fail with the same error after the same hashing
   * work. Throttled attempts fail before any verification.
   */
  async login(
    rawLoginName: string,
    password: string,
    clientAddress: string,
  ): Promise<{ token: string; session: AuthSession }> {
    let loginName: string;
    try {
      loginName = normalizeLoginName(rawLoginName);
    } catch {
      loginName = `invalid:${rawLoginName.slice(0, 128)}`;
    }
    const admitted = this.throttle.admit(loginName, clientAddress);
    if ("retryAfterMs" in admitted)
      throw new DeskmatesError(
        "rate_limited",
        "Too many failed sign-in attempts; try again later",
        {
          retryAfterSeconds: Math.ceil(admitted.retryAfterMs / 1000),
        },
      );
    const { ticket } = admitted;
    const fail = (): never => {
      ticket.failed();
      throw new DeskmatesError("token_rejected", LOGIN_REJECTED);
    };
    try {
      if (password.length === 0 || password.length > 1024) {
        await this.hasher.verifyAgainstNothing(password.slice(0, 1024));
        return fail();
      }
      const login = loginName.startsWith("invalid:")
        ? undefined
        : this.users.findLocalLogin(loginName);
      const hash = login ? this.users.passwordHash(login.id) : undefined;
      const verified = hash
        ? await this.hasher.verify(hash, password)
        : await this.hasher.verifyAgainstNothing(password);
      if (!login || !hash || !verified) return fail();
      // Verification awaited; a reset, disable or membership change may have landed meanwhile,
      // in this process or from the CLI. Re-read what was verified and issue the session in one
      // immediate transaction, so the session exists only if the verified password is still the
      // account's password at the moment it is written.
      const opened = this.db
        .transaction(() => {
          if (this.users.passwordHash(login.id) !== hash) return undefined;
          const user = this.users.getUser(login.userId);
          if (!user || user.status !== "active") return undefined;
          const created = this.sessions.create(user, login);
          if (this.enterableTenants(created.session).length > 0) return created;
          // Proven login, but no tenant this login may enter.
          this.sessions.revoke(created.session.id, "no_tenant");
          return undefined;
        })
        .immediate();
      if (!opened) return fail();
      ticket.succeeded();
      return opened;
    } finally {
      // An unexpected error frees the reservation; a no-op after `failed` or `succeeded`.
      ticket.released();
    }
  }

  /**
   * The principal a presented session token stands for, in the selected tenant. A selector is
   * only a request: it must name a tenant this session may enter now. Without one, the session
   * acts in the Default Tenant when it may, otherwise in its first enterable tenant. There is no
   * session-wide "current tenant" for two tabs to fight over (ADR-0022).
   */
  resolve(token: string, tenantId?: string): ResolvedSession | undefined {
    const session = this.sessions.authenticate(token);
    if (!session) return undefined;
    if (tenantId !== undefined) return this.resolveSession(session, tenantId);
    for (const candidate of this.enterableTenants(session))
      return this.resolveSession(session, candidate);
    return undefined;
  }

  /** Tenants this session may act in right now, the Default Tenant first. */
  enterableTenants(session: AuthSession): string[] {
    const ids = this.users
      .activeMemberships(session.userId)
      .map((membership) => membership.tenantId)
      .sort((a, b) =>
        a === DEFAULT_TENANT_ID ? -1 : b === DEFAULT_TENANT_ID ? 1 : a < b ? -1 : 1,
      );
    return ids.filter((id) => this.resolveSession(session, id) !== undefined);
  }

  private resolveSession(session: AuthSession, tenantId: string): ResolvedSession | undefined {
    const user = this.users.getUser(session.userId);
    if (!user || user.status !== "active") return undefined;
    const tenant = this.users.getTenant(tenantId);
    const membership = this.users.getMembership(tenantId, user.id);
    const grant = this.sessions.grant(session.id, tenantId);
    const access = evaluateTenantAccess({
      tenant,
      membership,
      grant,
      ssoIssuers:
        tenant?.authPolicy === "sso_required" ? this.users.tenantSsoIssuers(tenantId) : new Map(),
      now: this.clock(),
    });
    if (!access.ok || !membership) return undefined;
    const login = this.users.getLogin(session.loginId);
    return {
      session,
      principal: {
        kind: "user",
        userId: user.id,
        displayName: user.displayName,
        loginName: login?.provider === "local" ? login.subject : null,
        sessionId: session.id,
        tenantId,
        role: membership.role,
      },
    };
  }

  /**
   * Whether a session may keep a live connection it opened in `tenantId` (sweep and stream
   * re-checks). Without a tenant: whether it may still act in any tenant at all. A service
   * principal's live key is checked against its current token and tenant.
   */
  sessionStillAuthorized(sessionId: string, tenantId?: string): boolean {
    if (sessionId.startsWith(SERVICE_LIVE_PREFIX)) {
      const [id = "", hash = ""] = sessionId.slice(SERVICE_LIVE_PREFIX.length).split(":");
      const record = this.servicePrincipals.getAnyTenant(id);
      return (
        record !== undefined &&
        record.status === "active" &&
        record.tokenHash === hash &&
        (tenantId === undefined || record.tenantId === tenantId) &&
        this.users.getTenant(record.tenantId)?.status === "active"
      );
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined || !this.sessions.isLive(session)) return false;
    return tenantId === undefined
      ? this.enterableTenants(session).length > 0
      : this.resolveSession(session, tenantId) !== undefined;
  }

  // Service principals (ADR-0022 amendment 2).

  /**
   * The principal a presented service token stands for, re-read on every request: a disabled
   * principal, a replaced token or a suspended tenant resolves to nothing.
   */
  resolveServiceToken(token: string): ServicePrincipal | undefined {
    const record = this.servicePrincipals.findActiveByToken(token);
    if (!record || record.tokenHash === null) return undefined;
    if (this.users.getTenant(record.tenantId)?.status !== "active") return undefined;
    return {
      kind: "service",
      servicePrincipalId: record.id,
      name: record.name,
      tenantId: record.tenantId,
      role: record.role,
      liveKey: serviceLiveKey(record.id, record.tokenHash),
    };
  }

  /** Whether a principal of `tenantId` is active in an active tenant (lease sweep). */
  servicePrincipalActive(id: string, tenantId: string): boolean {
    return (
      this.servicePrincipals.get(tenantId, id)?.status === "active" &&
      this.users.getTenant(tenantId)?.status === "active"
    );
  }

  /** Disable a principal of `tenantId` for good and close what its token opened. */
  disableServicePrincipal(tenantId: string, id: string, by: string): ServicePrincipalRecord {
    const { record, previousHash } = this.servicePrincipals.disable(tenantId, id, by);
    if (previousHash !== null) this.live.closeSessions([serviceLiveKey(id, previousHash)]);
    return record;
  }

  /** Issue a new token for an active principal; the old one and its streams end now. */
  rotateServicePrincipal(
    tenantId: string,
    id: string,
    by = "operator",
  ): IssuedServicePrincipalView {
    const { record, token, previousHash } = this.servicePrincipals.rotate(tenantId, id, by);
    if (previousHash !== null) this.live.closeSessions([serviceLiveKey(id, previousHash)]);
    return { servicePrincipal: servicePrincipalView(record), token };
  }

  logout(sessionId: string): void {
    this.sessions.revoke(sessionId, "logout");
    this.live.closeSessions([sessionId]);
  }

  logoutAll(userId: string): number {
    const ids = this.sessions.revokeAllForUser(userId, "logout_all");
    this.live.closeSessions(ids);
    return ids.length;
  }

  /**
   * Change a signed-in person's password. The current password is the fresh re-authentication
   * this sensitive action needs. Every other session of the user is revoked, and the current one
   * is rotated: the caller gets a new token and the old one stops working.
   */
  async changePassword(
    principal: UserPrincipal,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ token: string; session: AuthSession }> {
    const session = this.sessions.get(principal.sessionId);
    const login = session ? this.users.getLogin(session.loginId) : undefined;
    if (!session || !login || login.provider !== "local")
      throw new DeskmatesError(
        "invalid_transition",
        "This session did not sign in with a password",
      );
    // Guessing the current password from a stolen session spends a budget keyed to this login
    // name, reserved before hashing so concurrent guesses cannot exceed it.
    const admitted = this.throttle.admit(login.subject, "password-change");
    if ("retryAfterMs" in admitted)
      throw new DeskmatesError("rate_limited", "Too many failed attempts; try again later", {
        retryAfterSeconds: Math.ceil(admitted.retryAfterMs / 1000),
      });
    const { ticket } = admitted;
    try {
      const problem = passwordProblem(newPassword, this.config.passwordMinLength);
      if (problem) throw new DeskmatesError("validation", problem);
      const hash = this.users.passwordHash(login.id);
      if (!hash || !(await this.hasher.verify(hash, currentPassword))) {
        ticket.failed();
        throw new DeskmatesError("forbidden", "Current password is incorrect");
      }
      const nextHash = await this.hasher.hash(newPassword);
      // Both awaits are over. Write the new hash only if the session is still signed in and the
      // password is still the one just verified; a logout, revocation or maintenance reset that
      // finished meanwhile wins, and nothing is overwritten or issued.
      const rotated = this.db
        .transaction(() => {
          if (!this.sessionStillAuthorized(principal.sessionId)) return "signed_out" as const;
          if (this.users.passwordHash(login.id) !== hash) return "changed" as const;
          this.users.setPasswordHash(login.id, nextHash);
          const revoked = this.sessions.revokeAllForUser(principal.userId, "password_changed");
          const user = this.users.getUser(principal.userId) as User;
          return { revoked, opened: this.sessions.create(user, login) };
        })
        .immediate();
      if (rotated === "signed_out") throw new DeskmatesError("token_rejected", "not signed in");
      if (rotated === "changed")
        throw new DeskmatesError(
          "invalid_transition",
          "The password was changed elsewhere while this request ran; sign in again",
        );
      ticket.succeeded();
      this.live.closeSessions(rotated.revoked);
      return rotated.opened;
    } finally {
      // Invalid input, a lost race or an internal error frees the reservation without counting
      // either way; a no-op after `failed` or `succeeded` above.
      ticket.released();
    }
  }

  // Tenant membership (ADR-0022 P4). Routes pass the acting principal; every rule is here.

  /** Members of one tenant. Never another tenant's memberships, and no global account data. */
  listMembers(tenantId: string): Array<{
    userId: string;
    displayName: string;
    loginName: string | null;
    role: TenantRole;
    status: "active" | "removed";
  }> {
    return (
      this.db
        .prepare(
          `SELECT m.user_id, m.status, u.display_name,
             (SELECT subject FROM user_logins l WHERE l.user_id = u.id AND l.provider = 'local') AS login_name
           FROM tenant_memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = ? ORDER BY m.status, u.display_name, u.id`,
        )
        .all(tenantId) as Array<{
        user_id: string;
        status: "active" | "removed";
        display_name: string;
        login_name: string | null;
      }>
    ).map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      loginName: row.login_name,
      role: this.users.getMembership(tenantId, row.user_id)?.role ?? "member",
      status: row.status,
    }));
  }

  /**
   * The people of one workspace and their role there (ADR-0022 amendment 6 W9), removed ones
   * after the active. The protected root is listed like anyone, marked `protected`.
   */
  /**
   * One offset page of a workspace's people (#113 slice M), in the order of
   * `listWorkspaceMembers`, optionally of one role or membership status, with the total under
   * the same filter.
   */
  pageWorkspaceMembers(
    tenantId: string,
    workspaceId: string,
    page: { offset: number; limit: number; role?: TenantRole; status?: "active" | "removed" },
  ): { members: ReturnType<AuthService["listWorkspaceMembers"]>; total: number } {
    const where = [
      "m.workspace_id = ?",
      "m.workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?)",
    ];
    const params: unknown[] = [workspaceId, tenantId];
    if (page.role !== undefined) {
      where.push("m.role = ?");
      params.push(page.role);
    }
    if (page.status !== undefined) {
      where.push("m.status = ?");
      params.push(page.status);
    }
    const clause = where.join(" AND ");
    const { total } = this.db
      .prepare(`SELECT count(*) AS total FROM workspace_memberships m WHERE ${clause}`)
      .get(...params) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT m.user_id, m.role, m.status, u.display_name, u.is_protected,
           (SELECT subject FROM user_logins l WHERE l.user_id = u.id AND l.provider = 'local') AS login_name
         FROM workspace_memberships m JOIN users u ON u.id = m.user_id
         WHERE ${clause} ORDER BY m.status, u.display_name, u.id LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset) as Array<{
      user_id: string;
      role: TenantRole;
      status: "active" | "removed";
      display_name: string;
      is_protected: number;
      login_name: string | null;
    }>;
    return {
      total,
      members: rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        loginName: row.login_name,
        role: row.role,
        status: row.status,
        workspaceId,
        protected: row.is_protected === 1,
      })),
    };
  }

  listWorkspaceMembers(
    tenantId: string,
    workspaceId: string,
  ): Array<{
    userId: string;
    displayName: string;
    loginName: string | null;
    role: TenantRole;
    status: "active" | "removed";
    workspaceId: string;
    protected: boolean;
  }> {
    return (
      this.db
        .prepare(
          `SELECT m.user_id, m.role, m.status, u.display_name, u.is_protected,
             (SELECT subject FROM user_logins l WHERE l.user_id = u.id AND l.provider = 'local') AS login_name
           FROM workspace_memberships m JOIN users u ON u.id = m.user_id
           JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.workspace_id = ? AND w.tenant_id = ? ORDER BY m.status, u.display_name, u.id`,
        )
        .all(workspaceId, tenantId) as Array<{
        user_id: string;
        role: TenantRole;
        status: "active" | "removed";
        display_name: string;
        is_protected: number;
        login_name: string | null;
      }>
    ).map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      loginName: row.login_name,
      role: row.role,
      status: row.status,
      workspaceId,
      protected: row.is_protected === 1,
    }));
  }

  /** Each workspace of the tenant where this person holds an active role, with that role. */
  workspaceRolesOf(
    tenantId: string,
    userId: string,
  ): Array<{ workspaceId: string; role: TenantRole }> {
    if (this.users.isProtected(userId))
      return [...this.workspacesOfTenant(tenantId)].map((workspaceId) => ({
        workspaceId,
        role: "owner" as const,
      }));
    const tenantWorkspaces = this.workspacesOfTenant(tenantId);
    return this.memberships
      .listForUser(userId)
      .filter((m) => tenantWorkspaces.has(m.workspaceId))
      .map((m) => ({ workspaceId: m.workspaceId, role: m.role }));
  }

  private workspacesOfTenant(tenantId: string): Set<string> {
    return new Set(
      (
        this.db
          .prepare("SELECT id FROM workspaces WHERE tenant_id = ? ORDER BY created_at, id")
          .all(tenantId) as Array<{ id: string }>
      ).map((row) => row.id),
    );
  }

  /**
   * The role an actor holds in one workspace: the operator credential and the protected
   * account are Owners of every workspace; anyone else holds their membership's role.
   */
  roleInWorkspace(actor: { userId: string | null }, workspaceId: string): TenantRole | undefined {
    if (actor.userId === null || this.users.isProtected(actor.userId)) return "owner";
    return this.memberships.roleIn(workspaceId, actor.userId);
  }

  /**
   * Change one membership. A role is changed in one workspace: there an Owner may set any role
   * (an Owner transfer is promote-then-demote); an Admin may only keep Members. Removing a person
   * from the tenant takes an Owner of every workspace they belong to, or themselves. A workspace
   * never loses its last Owner and the protected account is never demoted or removed. The
   * changed person's grants stop admitting at once and their streams close now.
   */
  changeMembership(
    actor: { userId: string | null; label: string },
    tenantId: string,
    targetUserId: string,
    change: { role?: TenantRole; status?: "active" | "removed"; workspaceId?: string },
  ): void {
    // A role change is checked and applied in one workspace, a removal from the tenant takes
    // other checks; one request that carries both would be checked as the first and applied as
    // the second (ADR-0022 amendment 6 W3, W4, W9).
    if (change.role !== undefined && change.status !== undefined)
      throw new DeskmatesError("validation", "change a role or a status, not both", {
        reason: "role_and_status",
      });
    const target = this.users.getMembership(tenantId, targetUserId);
    if (!target) throw new DeskmatesError("not_found", "Not found");
    if (this.users.isProtected(targetUserId) && (change.role !== undefined || change.status))
      throw new DeskmatesError("forbidden", "the protected account cannot be changed", {
        reason: "protected",
      });
    const self = targetUserId === actor.userId;
    const leaving = self && change.status === "removed" && change.role === undefined;
    if (!leaving) {
      const workspaces =
        change.workspaceId !== undefined
          ? [change.workspaceId]
          : this.memberships.listForUser(targetUserId).map((m) => m.workspaceId);
      for (const workspaceId of workspaces) {
        const actorRole = this.roleInWorkspace(actor, workspaceId);
        if (actorRole === "owner") continue;
        // An Admin manages Members and Guests and may promote to Admin; demoting or removing an
        // Admin and anything about Owner stay the Owner's (ADR-0022 amendment 6 W3, W4).
        const targetRole = this.memberships.roleIn(workspaceId, targetUserId);
        const allowed =
          actorRole === "admin" &&
          (targetRole === undefined || targetRole === "member" || targetRole === "guest") &&
          (change.role === undefined || change.role !== "owner");
        if (!allowed)
          throw new DeskmatesError("forbidden", "only an Owner may change this membership", {
            reason: "role",
          });
      }
    }
    if (change.workspaceId !== undefined && change.role === undefined && change.status) {
      // A removal (or re-activation) in one workspace leaves the person's other workspaces and
      // their tenant membership alone (W9).
      if (!this.memberships.get(change.workspaceId, targetUserId))
        throw new DeskmatesError("not_found", "Not found");
      this.memberships.change(
        change.workspaceId,
        targetUserId,
        { status: change.status },
        actor.label,
      );
    } else this.users.updateMembership(tenantId, targetUserId, change, actor.label);
    this.live.sweep();
  }

  /**
   * The open invitation a token names. A known but used, revoked or expired one is a 410 with
   * its reason; an unknown token is the uniform 401.
   */
  openInvitation(token: string): Invitation {
    const found = this.invitations.inspect(token);
    if (!found) throw invitationRejected();
    if (found.unusable) throw invitationUnusable(found.unusable);
    return found.invitation;
  }

  /** Whether a tenant may hold local password accounts created from now on (amendment 4 I5). */
  private requireLocalAccountsAllowed(tenantId: string): void {
    if (this.users.getTenant(tenantId)?.authPolicy === "sso_required") throw ssoRequired();
  }

  /**
   * Create an invitation in `tenantId`. A local new-account invitation is refused in a tenant
   * that requires SSO; role limits are the route's.
   */
  createInvitation(
    tenantId: string,
    input: {
      workspaceId: string;
      role: InvitationRole;
      target: InvitationTarget;
      createdBy: string;
      ttlSeconds?: number;
    },
  ): { invitation: Invitation; token: string } {
    if (input.target.kind === "local_signup" || input.target.kind === "local_new")
      this.requireLocalAccountsAllowed(tenantId);
    return this.invitations.create(tenantId, input);
  }

  /**
   * Accept a `local_new` invitation: create exactly the invited login name with the invited
   * role in the invited tenant, and sign in. The invitation is spent in the transaction that
   * creates the account, so two concurrent acceptances create at most one.
   */
  async acceptNewAccountInvitation(
    token: string,
    input: { displayName?: string; password: string },
  ): Promise<{ token: string; session: AuthSession }> {
    const invitation = this.openInvitation(token);
    if (invitation.targetKind !== "local_new" || invitation.targetValue === null)
      throw invitationRejected();
    const loginName = invitation.targetValue;
    this.requireLocalAccountsAllowed(invitation.tenantId);
    const displayName = normalizeDisplayName(input.displayName ?? loginName);
    const problem = passwordProblem(input.password, this.config.passwordMinLength);
    if (problem) throw new DeskmatesError("validation", problem);
    const passwordHash = await this.hasher.hash(input.password);
    const opened = this.db
      .transaction(() => {
        if (this.users.findLocalLogin(loginName)) return undefined;
        const created = this.users.createLocalUser({
          loginName,
          displayName,
          passwordHash,
          tenantId: invitation.tenantId,
          role: invitation.role,
          workspaceId: invitation.workspaceId,
        });
        // Spent here or the whole account is rolled back.
        if (!this.invitations.consume(invitation.id, created.user.id)) throw invitationRejected();
        return this.sessions.create(created.user, created.login);
      })
      .immediate();
    if (!opened) throw invitationRejected();
    return opened;
  }

  /**
   * Accept a `local_signup` invitation with a new account whose username the recipient chose
   * (ADR-0022 amendment 4 I1, I2). Everything is validated and the password hashed first; the
   * account, its membership and the invitation's consumption are then one transaction, so a
   * refusal (taken username, lost race) spends nothing and an existing account is never touched.
   */
  async acceptSignupInvitation(
    token: string,
    input: { loginName: string; displayName?: string; password: string },
  ): Promise<{ token: string; session: AuthSession; tenantId: string }> {
    const invitation = this.openInvitation(token);
    if (invitation.targetKind !== "local_signup") throw invitationRejected();
    this.requireLocalAccountsAllowed(invitation.tenantId);
    const loginName = normalizeLoginName(input.loginName);
    const displayName = normalizeDisplayName(input.displayName ?? loginName);
    const problem = passwordProblem(input.password, this.config.passwordMinLength);
    if (problem) throw new DeskmatesError("validation", problem);
    if (this.users.findLocalLogin(loginName)) throw loginNameTaken();
    const passwordHash = await this.hasher.hash(input.password);
    const opened = this.db
      .transaction(() => {
        if (this.users.findLocalLogin(loginName)) throw loginNameTaken();
        const created = this.users.createLocalUser({
          loginName,
          displayName,
          passwordHash,
          tenantId: invitation.tenantId,
          role: invitation.role,
          workspaceId: invitation.workspaceId,
        });
        // Spent here or the whole account is rolled back.
        if (!this.invitations.consume(invitation.id, created.user.id)) {
          const now = this.invitations.inspect(token);
          throw now?.unusable ? invitationUnusable(now.unusable) : invitationRejected();
        }
        return this.sessions.create(created.user, created.login);
      })
      .immediate();
    return { ...opened, tenantId: invitation.tenantId };
  }

  /**
   * Accept an invitation from the signed-in account's own session: a `local_user` invitation
   * for exactly that local login, or an open `local_signup` link with whatever account the
   * session belongs to. Adds the membership (an existing active one keeps its role: an
   * invitation never demotes or promotes) and grants this session the tenant when its policy
   * accepts the session's login.
   */
  acceptExistingAccountInvitation(token: string, principal: UserPrincipal): Invitation {
    const invitation = this.openInvitation(token);
    const session = this.sessions.get(principal.sessionId);
    const login = session ? this.users.getLogin(session.loginId) : undefined;
    const allowed =
      invitation.targetKind === "local_signup" ||
      (invitation.targetKind === "local_user" &&
        login?.provider === "local" &&
        login.subject === invitation.targetValue);
    if (!allowed || !session || !login) throw invitationRejected();
    this.db
      .transaction(() => {
        this.joinTenant(invitation, principal.userId);
        this.sessions.issueGrant(
          session.id,
          invitation.tenantId,
          login,
          new Date(Date.parse(session.authenticatedAt)),
        );
      })
      .immediate();
    return invitation;
  }

  /**
   * An Admin creates a local account in their tenant (ADR-0022 amendment 4 I4). The Gateway
   * generates the initial password and returns it to this one caller; only its hash is stored.
   * An Admin creates Members, an Owner also Admins, nobody an Owner; an existing username is
   * refused and its account untouched.
   */
  async createAccount(
    actor: { userId: string | null; label: string },
    tenantId: string,
    input: { loginName: unknown; displayName?: unknown; role: unknown; workspaceId: string },
  ): Promise<{ user: User; loginName: string; initialPassword: string }> {
    const role = input.role;
    if (role !== "member" && role !== "admin" && role !== "guest")
      throw new DeskmatesError("validation", "role must be admin, member or guest");
    // An Owner or Admin of the workspace creates Admins, Members and Guests (amendment 6 W4).
    const actorRole = this.roleInWorkspace(actor, input.workspaceId);
    if (actorRole !== "owner" && actorRole !== "admin")
      throw new DeskmatesError("forbidden", "requires the admin role in this workspace", {
        reason: "role",
      });
    if (typeof input.loginName !== "string")
      throw new DeskmatesError("validation", "loginName must be a string");
    const loginName = normalizeLoginName(input.loginName);
    const displayName = normalizeDisplayName(input.displayName ?? loginName);
    this.requireLocalAccountsAllowed(tenantId);
    if (this.users.findLocalLogin(loginName)) throw loginNameTaken();
    const initialPassword = generateInitialPassword(this.config.passwordMinLength);
    const passwordHash = await this.hasher.hash(initialPassword);
    const created = this.db
      .transaction(() => {
        if (this.users.findLocalLogin(loginName)) throw loginNameTaken();
        return this.users.createLocalUser({
          loginName,
          displayName,
          passwordHash,
          tenantId,
          role,
          workspaceId: input.workspaceId,
          mustChangePassword: true,
        });
      })
      .immediate();
    return { user: created.user, loginName, initialPassword };
  }

  /**
   * Spend `invitation` for `userId` and give them its role in its workspace; throws when already
   * spent. An existing active membership in that workspace keeps its role: an invitation never
   * demotes or promotes.
   */
  joinTenant(invitation: Invitation, userId: string): void {
    this.db
      .transaction(() => {
        if (!this.invitations.consume(invitation.id, userId)) throw invitationRejected();
        this.users.addMembership(
          invitation.tenantId,
          userId,
          invitation.role,
          invitation.workspaceId,
        );
      })
      .immediate();
  }

  // Platform maintenance. None of these is reachable from an HTTP route.

  /**
   * On an empty database, create the protected root account (ADR-0031 decision 8): login
   * `admin`, password `admin`, which its first session must change before anything else. It is
   * the installation's platform maintainer and Owner of every workspace. Returns undefined when
   * any account exists: the root is never created twice and never chosen by name.
   */
  async ensureProtectedRoot(): Promise<User | undefined> {
    if (this.users.userCount() > 0) return undefined;
    // The default password is the owner's decision (Q6); it is not subject to the length rule
    // because it can do nothing but be changed.
    const passwordHash = await this.hasher.hash(PROTECTED_ROOT_DEFAULT_PASSWORD);
    return this.db
      .transaction(() => {
        if (this.users.userCount() > 0) return undefined;
        const { user } = this.users.createLocalUser({
          loginName: PROTECTED_ROOT_LOGIN,
          displayName: "Administrator",
          passwordHash,
          tenantId: DEFAULT_TENANT_ID,
          role: "owner",
          protectedRoot: true,
          mustChangePassword: true,
        });
        this.users.setPlatformRole(user.id, "maintainer");
        return this.users.getUser(user.id) as User;
      })
      .immediate();
  }

  /**
   * Maintenance before first start (CLI): create the protected root account with a login name
   * and password the operator chose over a trusted channel, instead of the default `admin`.
   * Refused once any account exists, like `ensureProtectedRoot`.
   */
  async bootstrapRoot(input: {
    loginName: string;
    displayName: string;
    password: string;
  }): Promise<User> {
    if (!this.setupRequired())
      throw new DeskmatesError(
        "invalid_transition",
        "An account already exists; bootstrap is closed",
      );
    const user = await this.createUser({ ...input, role: "owner", protectedRoot: true });
    this.users.setPlatformRole(user.id, "maintainer");
    return this.users.getUser(user.id) as User;
  }

  /** Whether this session's login still holds a default password that must be changed. */
  mustChangePassword(session: AuthSession): boolean {
    return this.users.mustChangePassword(session.loginId);
  }

  async createUser(input: {
    loginName: string;
    displayName: string;
    password: string;
    role: TenantRole;
    tenantId?: string;
    /** The workspace the role is granted in; without one, every current workspace. */
    workspaceId?: string;
    /**
     * Make this the protected root account (ADR-0031 decision 8) with a chosen password: for
     * test fixtures that stand in for an installation's first account. Refused when one exists.
     */
    protectedRoot?: boolean;
    /** The maintenance CLI chose this password for somebody else. */
    mustChangePassword?: boolean;
  }): Promise<User> {
    const problem = passwordProblem(input.password, this.config.passwordMinLength);
    if (problem) throw new DeskmatesError("validation", problem);
    const passwordHash = await this.hasher.hash(input.password);
    return this.users.createLocalUser({
      loginName: input.loginName,
      displayName: input.displayName,
      passwordHash,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      role: input.role,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.protectedRoot ? { protectedRoot: true } : {}),
      ...(input.mustChangePassword ? { mustChangePassword: true } : {}),
    }).user;
  }

  /** Maintenance password reset: sets the password and revokes every session of the user. */
  async resetPassword(rawLoginName: string, password: string): Promise<number> {
    const login = this.mustFindLocal(rawLoginName);
    const problem = passwordProblem(password, this.config.passwordMinLength);
    if (problem) throw new DeskmatesError("validation", problem);
    this.users.setPasswordHash(login.id, await this.hasher.hash(password), "administrator");
    const revoked = this.sessions.revokeAllForUser(login.userId, "password_changed");
    this.live.closeSessions(revoked);
    return revoked.length;
  }

  setUserDisabled(rawLoginName: string, disabled: boolean): number {
    const login = this.mustFindLocal(rawLoginName);
    if (disabled && this.users.isProtected(login.userId))
      throw new DeskmatesError(
        "invalid_transition",
        "the protected root account cannot be disabled",
      );
    this.users.setUserStatus(login.userId, disabled ? "disabled" : "active");
    if (!disabled) return 0;
    const revoked = this.sessions.revokeAllForUser(login.userId, "user_disabled");
    this.live.closeSessions(revoked);
    return revoked.length;
  }

  revokeSessions(rawLoginName: string): number {
    const login = this.mustFindLocal(rawLoginName);
    const revoked = this.sessions.revokeAllForUser(login.userId, "maintenance");
    this.live.closeSessions(revoked);
    return revoked.length;
  }

  private mustFindLocal(rawLoginName: string) {
    const login = this.users.findLocalLogin(normalizeLoginName(rawLoginName));
    if (!login) throw new DeskmatesError("not_found", "no such login name");
    return login;
  }
}
