// Users, their logins, tenants and memberships (ADR-0022 decision 1). A user is a global person;
// what they may do in a tenant is their membership there. A login is keyed by provider + issuer +
// subject, never by an email string. ADR-0022 calls a login an "AuthIdentity"; the schema says
// `user_logins` because ADR-0004 item 4 reserves `identity*` names (removed bot identities).

import { createHash } from "node:crypto";
import {
  type AvatarContentType,
  DeskmatesError,
  TENANT_ROLES,
  type TenantRole,
  type UpdatePreferencesRequest,
  type UserPreferences,
} from "@deskmates/contracts";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { WorkspaceMembershipStore } from "../workspaces/memberships.js";
import { readPreferences } from "./user-preferences.js";

export const DEFAULT_TENANT_ID = "tnt_default";
export const LOCAL_ISSUER = "local";

export type UserStatus = "active" | "disabled";
export type MembershipStatus = "active" | "removed";
export type TenantAuthPolicy = "local_or_sso" | "sso_optional" | "sso_required";

export interface User {
  id: string;
  displayName: string;
  status: UserStatus;
  /** Installation-wide maintenance (ADR-0022): distinct from any tenant role. */
  platformRole: "maintainer" | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserLogin {
  id: string;
  userId: string;
  provider: "local" | "oidc";
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

export interface Tenant {
  id: string;
  name: string;
  status: "active" | "suspended";
  authPolicy: TenantAuthPolicy;
  authPolicyVersion: number;
}

export interface TenantMembership {
  tenantId: string;
  userId: string;
  /**
   * Not stored (ADR-0031 Q1: no tenant roles). The highest role the person holds in any
   * workspace of the tenant, for routes that name no workspace; `member` when they hold none
   * above Guest, which is the reading access every tenant account had before.
   */
  role: TenantRole;
  status: MembershipStatus;
  authVersion: number;
}

interface UserRow {
  id: string;
  display_name: string;
  status: UserStatus;
  platform_role: "maintainer" | null;
  created_at: string;
  updated_at: string;
}

interface LoginRow {
  id: string;
  user_id: string;
  provider: "local" | "oidc";
  issuer: string;
  subject: string;
  email: string | null;
  email_verified: number;
}

interface TenantRow {
  id: string;
  name: string;
  status: "active" | "suspended";
  auth_policy: TenantAuthPolicy;
  auth_policy_version: number;
}

interface MembershipRow {
  tenant_id: string;
  user_id: string;
  status: MembershipStatus;
  auth_version: number;
}

const LOGIN_NAME = /^[a-z0-9][a-z0-9._@+-]{0,127}$/;

/**
 * The subject of a local login. Case-insensitive and trimmed so `Alice@Example.com` and
 * `alice@example.com` are one account; anything outside a conservative alphabet is refused.
 */
export function normalizeLoginName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!LOGIN_NAME.test(name))
    throw new DeskmatesError(
      "validation",
      "login name must be 1-128 characters of a-z, 0-9, '.', '_', '@', '+' or '-'",
    );
  return name;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    platformRole: row.platform_role ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLogin(row: LoginRow): UserLogin {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email,
    emailVerified: row.email_verified === 1,
  };
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    authPolicy: row.auth_policy,
    authPolicyVersion: row.auth_policy_version,
  };
}

function toMembership(row: MembershipRow, role: TenantRole): TenantMembership {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    role,
    status: row.status,
    authVersion: row.auth_version,
  };
}

export class UserStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  /** The person's own UI preferences; none for an unknown user. */
  getPreferences(userId: string): UserPreferences {
    const row = this.db.prepare("SELECT preferences_json FROM users WHERE id = ?").get(userId) as
      | { preferences_json: string }
      | undefined;
    return row ? readPreferences(row.preferences_json) : {};
  }

  /** Merge a change into the stored object (JSON merge patch); every other key stays. */
  updatePreferences(userId: string, change: UpdatePreferencesRequest): UserPreferences {
    const result = this.db
      .prepare(
        "UPDATE users SET preferences_json = json_patch(preferences_json, ?), updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(change), this.now(), userId);
    if (result.changes === 0) throw new DeskmatesError("not_found", "user not found");
    return this.getPreferences(userId);
  }

  /** Change a person's own display name (ADR-0022 amendment 3); nothing else on the row. */
  setDisplayName(userId: string, displayName: string): User {
    const result = this.db
      .prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
      .run(displayName, this.now(), userId);
    if (result.changes === 0) throw new DeskmatesError("not_found", "user not found");
    return this.getUser(userId) as User;
  }

  /** The stored avatar's type and hash, without its bytes; undefined for the name fallback. */
  avatarMeta(userId: string): { contentType: AvatarContentType; sha256: string } | undefined {
    const row = this.db
      .prepare("SELECT content_type, sha256 FROM user_avatars WHERE user_id = ?")
      .get(userId) as { content_type: AvatarContentType; sha256: string } | undefined;
    return row ? { contentType: row.content_type, sha256: row.sha256 } : undefined;
  }

  getAvatar(userId: string): { contentType: AvatarContentType; bytes: Buffer } | undefined {
    const row = this.db
      .prepare("SELECT content_type, bytes FROM user_avatars WHERE user_id = ?")
      .get(userId) as { content_type: AvatarContentType; bytes: Buffer } | undefined;
    return row ? { contentType: row.content_type, bytes: row.bytes } : undefined;
  }

  /** Replace the person's avatar with checked image bytes, in one statement. */
  setAvatar(userId: string, contentType: AvatarContentType, bytes: Buffer): string {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.db
      .prepare(
        `INSERT INTO user_avatars (user_id, content_type, bytes, sha256, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET content_type = excluded.content_type,
           bytes = excluded.bytes, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
      )
      .run(userId, contentType, bytes, sha256, this.now());
    return sha256;
  }

  removeAvatar(userId: string): void {
    this.db.prepare("DELETE FROM user_avatars WHERE user_id = ?").run(userId);
  }

  /**
   * The account's local login name and whether it has a password, independent of how any one
   * session signed in (ADR-0022 amendment 3 P5).
   */
  localPassword(userId: string): { loginName: string; hasPassword: boolean } | undefined {
    const row = this.db
      .prepare(
        `SELECT l.subject AS login_name, c.login_id IS NOT NULL AS has_password
         FROM user_logins l LEFT JOIN local_credentials c ON c.login_id = l.id
         WHERE l.user_id = ? AND l.provider = 'local' ORDER BY l.created_at, l.id LIMIT 1`,
      )
      .get(userId) as { login_name: string; has_password: number } | undefined;
    return row ? { loginName: row.login_name, hasPassword: row.has_password === 1 } : undefined;
  }

  listUsers(): Array<User & { loginName: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT u.*, i.subject AS login_name FROM users u
         LEFT JOIN user_logins i ON i.user_id = u.id AND i.provider = 'local'
         ORDER BY u.created_at, u.id`,
      )
      .all() as Array<UserRow & { login_name: string | null }>;
    return rows.map((row) => ({ ...toUser(row), loginName: row.login_name }));
  }

  findLocalLogin(loginName: string): UserLogin | undefined {
    const row = this.db
      .prepare("SELECT * FROM user_logins WHERE provider = 'local' AND issuer = ? AND subject = ?")
      .get(LOCAL_ISSUER, loginName) as LoginRow | undefined;
    return row ? toLogin(row) : undefined;
  }

  getLogin(id: string): UserLogin | undefined {
    const row = this.db.prepare("SELECT * FROM user_logins WHERE id = ?").get(id) as
      | LoginRow
      | undefined;
    return row ? toLogin(row) : undefined;
  }

  passwordHash(loginId: string): string | undefined {
    const row = this.db
      .prepare("SELECT password_hash FROM local_credentials WHERE login_id = ?")
      .get(loginId) as { password_hash: string } | undefined;
    return row?.password_hash;
  }

  /** Store a password hash; a self-set password has no forced-change reason. */
  setPasswordHash(
    loginId: string,
    passwordHash: string,
    mustChangeReason: "default" | "administrator" | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO local_credentials
           (login_id, password_hash, must_change, password_change_reason, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(login_id) DO UPDATE SET password_hash = excluded.password_hash,
           must_change = excluded.must_change,
           password_change_reason = excluded.password_change_reason,
           updated_at = excluded.updated_at`,
      )
      .run(loginId, passwordHash, mustChangeReason === null ? 0 : 1, mustChangeReason, this.now());
  }

  /** Whether this login still has a default password it must change first (ADR-0031 8). */
  mustChangePassword(loginId: string): boolean {
    const row = this.db
      .prepare("SELECT must_change FROM local_credentials WHERE login_id = ?")
      .get(loginId) as { must_change: number } | undefined;
    return row?.must_change === 1;
  }

  /** The protected root account, if the installation has one. */
  protectedRoot(): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE is_protected = 1").get() as
      | UserRow
      | undefined;
    return row ? toUser(row) : undefined;
  }

  isProtected(userId: string): boolean {
    const row = this.db.prepare("SELECT is_protected FROM users WHERE id = ?").get(userId) as
      | { is_protected: number }
      | undefined;
    return row?.is_protected === 1;
  }

  /** Grant `role` in one workspace, or in every active workspace of the tenant. */
  grantRole(tenantId: string, userId: string, role: TenantRole, workspaceId?: string): void {
    const memberships = new WorkspaceMembershipStore(this.db);
    const targets =
      workspaceId !== undefined
        ? [workspaceId]
        : (
            this.db
              .prepare("SELECT id FROM workspaces WHERE tenant_id = ? AND archived_at IS NULL")
              .all(tenantId) as Array<{ id: string }>
          ).map((r) => r.id);
    for (const id of targets) memberships.add(id, userId, role, "system:account");
  }

  /** The tenant-level role a membership row stands for (see `TenantMembership.role`). */
  private tenantRole(tenantId: string, userId: string): TenantRole {
    return new WorkspaceMembershipStore(this.db).highestRole(tenantId, userId) ?? "guest";
  }

  /**
   * Create a person with a local login and a membership, in one transaction. Callers are platform
   * maintenance (the CLI); there is no self-service signup route.
   */
  createLocalUser(input: {
    loginName: string;
    displayName: string;
    passwordHash: string;
    tenantId: string;
    /**
     * The role to grant: in `workspaceId` when given, otherwise in every active workspace the
     * tenant has now (the narrowest reading of the former tenant-wide role).
     */
    role: TenantRole;
    workspaceId?: string;
    /** The protected root account (ADR-0031 decision 8); only `ensureProtectedRoot` sets it. */
    protectedRoot?: boolean;
    /** A default password the first session must change. */
    mustChangePassword?: boolean;
  }): { user: User; login: UserLogin } {
    const loginName = normalizeLoginName(input.loginName);
    const displayName = input.displayName.trim();
    if (!displayName) throw new DeskmatesError("validation", "display name is required");
    if (!TENANT_ROLES.includes(input.role))
      throw new DeskmatesError("validation", "role must be owner, admin, member or guest");
    return this.db
      .transaction(() => {
        if (this.findLocalLogin(loginName))
          throw new DeskmatesError("invalid_transition", "login name already exists");
        if (!this.getTenant(input.tenantId))
          throw new DeskmatesError("not_found", "tenant not found", { tenantId: input.tenantId });
        const at = this.now();
        const userId = newId("usr");
        const loginId = newId("aid");
        this.db
          .prepare(
            "INSERT INTO users (id, display_name, status, is_protected, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
          )
          .run(userId, displayName, input.protectedRoot ? 1 : 0, at, at);
        this.db
          .prepare(
            `INSERT INTO user_logins (id, user_id, provider, issuer, subject, created_at)
             VALUES (?, ?, 'local', ?, ?, ?)`,
          )
          .run(loginId, userId, LOCAL_ISSUER, loginName, at);
        this.setPasswordHash(
          loginId,
          input.passwordHash,
          input.mustChangePassword === true
            ? input.protectedRoot
              ? "default"
              : "administrator"
            : null,
        );
        this.db
          .prepare(
            `INSERT INTO tenant_memberships (tenant_id, user_id, status, created_at, updated_at)
             VALUES (?, ?, 'active', ?, ?)`,
          )
          .run(input.tenantId, userId, at, at);
        if (!input.protectedRoot)
          this.grantRole(input.tenantId, userId, input.role, input.workspaceId);
        return {
          user: this.getUser(userId) as User,
          login: this.getLogin(loginId) as UserLogin,
        };
      })
      .immediate();
  }

  setPlatformRole(userId: string, role: "maintainer" | null): void {
    const result = this.db
      .prepare("UPDATE users SET platform_role = ?, updated_at = ? WHERE id = ?")
      .run(role, this.now(), userId);
    if (result.changes === 0) throw new DeskmatesError("not_found", "user not found");
  }

  /**
   * Take platform maintenance away from one person (issue #14). Refused when it would leave no
   * active maintainer: the installation would then be kept only by the operator credential.
   * Returns false when the person was not a maintainer.
   */
  revokePlatformMaintainer(userId: string): boolean {
    return this.db
      .transaction(() => {
        const user = this.getUser(userId);
        if (!user) throw new DeskmatesError("not_found", "user not found");
        if (user.platformRole !== "maintainer") return false;
        const others = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM users
             WHERE platform_role = 'maintainer' AND status = 'active' AND id <> ?`,
          )
          .get(userId) as { n: number };
        if (others.n === 0)
          throw new DeskmatesError(
            "invalid_transition",
            "refusing to revoke the last platform maintainer; grant another active user first",
          );
        this.setPlatformRole(userId, null);
        return true;
      })
      .immediate();
  }

  /** People whose logins carry this verified email, compared case-insensitively. */
  userIdsByLoginEmail(email: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT user_id FROM user_logins
           WHERE email_verified = 1 AND lower(email) = lower(?) ORDER BY user_id`,
        )
        .all(email.trim()) as Array<{ user_id: string }>
    ).map((row) => row.user_id);
  }

  setUserStatus(userId: string, status: UserStatus): void {
    const result = this.db
      .prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), userId);
    if (result.changes === 0) throw new DeskmatesError("not_found", "user not found");
  }

  /**
   * Create a tenant (platform maintenance only; ADR-0022). A new tenant starts with the
   * local-or-SSO policy.
   */
  createTenant(input: { name: string; id?: string }): Tenant {
    const name = input.name.trim();
    if (!name) throw new DeskmatesError("validation", "tenant name is required");
    const id = input.id ?? newId("tnt");
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO tenants (id, name, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(id, name, at, at);
    return this.getTenant(id) as Tenant;
  }

  listTenants(): Tenant[] {
    return (
      this.db.prepare("SELECT * FROM tenants ORDER BY created_at, id").all() as TenantRow[]
    ).map(toTenant);
  }

  /**
   * Add a person to a tenant, or re-activate a removed membership, and grant `role` in
   * `workspaceId` (or, without one, in every active workspace of the tenant).
   */
  addMembership(
    tenantId: string,
    userId: string,
    role: TenantRole,
    workspaceId?: string,
  ): TenantMembership {
    if (!TENANT_ROLES.includes(role))
      throw new DeskmatesError("validation", "role must be owner, admin, member or guest");
    return this.db
      .transaction(() => {
        if (!this.getTenant(tenantId)) throw new DeskmatesError("not_found", "tenant not found");
        if (!this.getUser(userId)) throw new DeskmatesError("not_found", "user not found");
        const at = this.now();
        if (this.getMembership(tenantId, userId))
          this.db
            .prepare(
              `UPDATE tenant_memberships SET status = 'active',
                 auth_version = auth_version + 1, updated_at = ? WHERE tenant_id = ? AND user_id = ?`,
            )
            .run(at, tenantId, userId);
        else
          this.db
            .prepare(
              `INSERT INTO tenant_memberships (tenant_id, user_id, status, created_at, updated_at)
               VALUES (?, ?, 'active', ?, ?)`,
            )
            .run(tenantId, userId, at, at);
        this.grantRole(tenantId, userId, role, workspaceId);
        return this.getMembership(tenantId, userId) as TenantMembership;
      })
      .immediate();
  }

  findLogin(provider: "local" | "oidc", issuer: string, subject: string): UserLogin | undefined {
    const row = this.db
      .prepare("SELECT * FROM user_logins WHERE provider = ? AND issuer = ? AND subject = ?")
      .get(provider, issuer, subject) as LoginRow | undefined;
    return row ? toLogin(row) : undefined;
  }

  loginsOf(userId: string): UserLogin[] {
    return (
      this.db
        .prepare("SELECT * FROM user_logins WHERE user_id = ? ORDER BY created_at, id")
        .all(userId) as LoginRow[]
    ).map(toLogin);
  }

  /**
   * Attach an external identity to an existing person. The identity is issuer + subject; an
   * identity already attached to someone else is refused, never moved (ADR-0022 decision 3).
   */
  addOidcLogin(
    userId: string,
    identity: { issuer: string; subject: string; email: string | null; emailVerified: boolean },
  ): UserLogin {
    return this.db
      .transaction(() => {
        const existing = this.findLogin("oidc", identity.issuer, identity.subject);
        if (existing) {
          if (existing.userId !== userId)
            throw new DeskmatesError("invalid_transition", "identity belongs to another account");
          return existing;
        }
        if (!this.getUser(userId)) throw new DeskmatesError("not_found", "user not found");
        const id = newId("aid");
        this.db
          .prepare(
            `INSERT INTO user_logins (id, user_id, provider, issuer, subject, email, email_verified, created_at)
             VALUES (?, ?, 'oidc', ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            userId,
            identity.issuer,
            identity.subject,
            identity.email,
            identity.emailVerified ? 1 : 0,
            this.now(),
          );
        return this.getLogin(id) as UserLogin;
      })
      .immediate();
  }

  /**
   * A just-in-time account for an unknown external identity: a new person, the identity and a
   * Member membership in one tenant. The caller has checked that the tenant allows JIT for this
   * provider; the role is fixed here so no claim can raise it.
   */
  createOidcUser(input: {
    displayName: string;
    issuer: string;
    subject: string;
    email: string | null;
    emailVerified: boolean;
    tenantId: string;
    /**
     * With an invitation for this exact identity: its role in its workspace. A just-in-time
     * account without one joins the tenant with no workspace role (ADR-0031 decision 7).
     */
    role?: "member" | "admin" | "guest";
    workspaceId?: string;
  }): { user: User; login: UserLogin } {
    return this.db
      .transaction(() => {
        if (this.findLogin("oidc", input.issuer, input.subject))
          throw new DeskmatesError("invalid_transition", "identity already has an account");
        if (!this.getTenant(input.tenantId))
          throw new DeskmatesError("not_found", "tenant not found");
        const at = this.now();
        const userId = newId("usr");
        const displayName = input.displayName.trim().slice(0, 128) || "SSO user";
        this.db
          .prepare(
            "INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
          )
          .run(userId, displayName, at, at);
        this.db
          .prepare(
            `INSERT INTO tenant_memberships (tenant_id, user_id, status, created_at, updated_at)
             VALUES (?, ?, 'active', ?, ?)`,
          )
          .run(input.tenantId, userId, at, at);
        if (input.workspaceId !== undefined)
          this.grantRole(input.tenantId, userId, input.role ?? "member", input.workspaceId);
        const login = this.addOidcLogin(userId, input);
        return { user: this.getUser(userId) as User, login };
      })
      .immediate();
  }

  /**
   * Issuers of the active providers a tenant links, with each one's maximum authentication age.
   * Read on every authorization, so unlinking or disabling a provider applies on the next request.
   */
  tenantSsoIssuers(tenantId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT p.issuer, l.max_auth_age_seconds AS age FROM tenant_sso_providers l
         JOIN oidc_providers p ON p.id = l.provider_id
         WHERE l.tenant_id = ? AND p.status = 'active'`,
      )
      .all(tenantId) as Array<{ issuer: string; age: number }>;
    return new Map(rows.map((row) => [row.issuer, row.age]));
  }

  /**
   * Change a tenant's login policy. Bumps the policy version, so every grant issued under the
   * old policy stops admitting and sessions must show evidence the new policy accepts.
   */
  setTenantPolicy(tenantId: string, policy: TenantAuthPolicy): Tenant {
    if (!["local_or_sso", "sso_optional", "sso_required"].includes(policy))
      throw new DeskmatesError(
        "validation",
        "policy must be local_or_sso, sso_optional or sso_required",
      );
    const result = this.db
      .prepare(
        `UPDATE tenants SET auth_policy = ?, auth_policy_version = auth_policy_version + 1,
           updated_at = ? WHERE id = ?`,
      )
      .run(policy, this.now(), tenantId);
    if (result.changes === 0) throw new DeskmatesError("not_found", "tenant not found");
    return this.getTenant(tenantId) as Tenant;
  }

  setTenantStatus(tenantId: string, status: Tenant["status"]): Tenant {
    const result = this.db
      .prepare("UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), tenantId);
    if (result.changes === 0) throw new DeskmatesError("not_found", "tenant not found");
    return this.getTenant(tenantId) as Tenant;
  }

  getTenant(id: string): Tenant | undefined {
    const row = this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as
      | TenantRow
      | undefined;
    return row ? toTenant(row) : undefined;
  }

  getMembership(tenantId: string, userId: string): TenantMembership | undefined {
    const row = this.db
      .prepare("SELECT * FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?")
      .get(tenantId, userId) as MembershipRow | undefined;
    return row ? toMembership(row, this.tenantRole(tenantId, userId)) : undefined;
  }

  activeMemberships(userId: string): TenantMembership[] {
    return (
      this.db
        .prepare(
          `SELECT m.* FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
           WHERE m.user_id = ? AND m.status = 'active' AND t.status = 'active'
           ORDER BY m.tenant_id`,
        )
        .all(userId) as MembershipRow[]
    ).map((row) => toMembership(row, this.tenantRole(row.tenant_id, userId)));
  }

  /**
   * Change a person's role in one workspace, or remove them from the tenant (and so from every
   * workspace of it), and bump the tenant membership's authorization version so every grant
   * issued under the old version stops admitting at once. A workspace never loses its last
   * Owner, and the protected account is never removed (ADR-0031 decisions 7 and 8).
   */
  updateMembership(
    tenantId: string,
    userId: string,
    change: { role?: TenantRole; status?: MembershipStatus; workspaceId?: string },
    by = "operator",
  ): TenantMembership {
    return this.db
      .transaction(() => {
        const current = this.getMembership(tenantId, userId);
        if (!current) throw new DeskmatesError("not_found", "membership not found");
        const memberships = new WorkspaceMembershipStore(this.db);
        if (change.role !== undefined) {
          if (change.workspaceId === undefined)
            throw new DeskmatesError("validation", "a role is changed in one workspace");
          if (memberships.get(change.workspaceId, userId))
            memberships.change(change.workspaceId, userId, { role: change.role }, by);
          else memberships.add(change.workspaceId, userId, change.role, by);
        }
        if (change.status === "removed" && current.status === "active") {
          if (this.isProtected(userId))
            throw new DeskmatesError(
              "invalid_transition",
              "the protected account cannot be removed",
            );
          const workspaceIds = (
            this.db
              .prepare(
                `SELECT m.workspace_id FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
                 WHERE m.user_id = ? AND m.status = 'active' AND w.tenant_id = ?`,
              )
              .all(userId, tenantId) as Array<{ workspace_id: string }>
          ).map((r) => r.workspace_id);
          for (const id of workspaceIds) memberships.change(id, userId, { status: "removed" }, by);
        }
        const status = change.status ?? current.status;
        this.db
          .prepare(
            `UPDATE tenant_memberships SET status = ?, auth_version = auth_version + 1,
               updated_at = ? WHERE tenant_id = ? AND user_id = ?`,
          )
          .run(status, this.now(), tenantId, userId);
        return this.getMembership(tenantId, userId) as TenantMembership;
      })
      .immediate();
  }
}
