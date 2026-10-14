// T1: ADR-0022 decisions 1-2 / test plan AUTH-02, AUTH-04, ROLE-02 baseline. Sessions are
// hash-only, expire by idle and absolute bounds, revoke per session or per user, and a tenant
// grant stops admitting when the tenant, membership or policy it was issued under changes.

import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { createOwner } from "../test-support/owner.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { AuthService } from "./auth-service.js";
import { evaluateTenantAccess } from "./session-store.js";
import { DEFAULT_TENANT_ID } from "./user-store.js";

const FAST = { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 };
const PASSWORD = "correct horse battery staple";

let db: GatewayDb;
let now: Date;
let auth: AuthService;

beforeEach(() => {
  db = openDatabase(":memory:");
  now = new Date("2026-10-05T00:00:00.000Z");
  auth = new AuthService(
    db,
    { ...FAST, sessionIdleTtlSeconds: 3600, sessionAbsoluteTtlSeconds: 4 * 3600 },
    () => now,
  );
});

function advance(seconds: number): void {
  now = new Date(now.getTime() + seconds * 1000);
}

async function owner() {
  await createOwner(
    auth,
    {
      loginName: "Owner@Example.com",
      displayName: "Owner",
      password: PASSWORD,
    },
    { root: false },
  );
  return auth.login("owner@example.com", PASSWORD, "127.0.0.1");
}

function everyText(): string {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((row) => row.name);
  return tables
    .map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all()))
    .join("\n");
}

describe("persistent sessions", () => {
  it("stores only a hash of the 256-bit session token", async () => {
    const { token, session } = await owner();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(everyText()).not.toContain(token);
    expect(everyText()).not.toContain(PASSWORD);
    const row = db.prepare("SELECT token_hash FROM auth_sessions WHERE id = ?").get(session.id) as {
      token_hash: string;
    };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.resolve(token)?.principal).toMatchObject({
      kind: "user",
      tenantId: DEFAULT_TENANT_ID,
      // No workspace exists yet, so no workspace role: guest (ADR-0022 amendment 6 W1).
      role: "guest",
      loginName: "owner@example.com",
    });
  });

  it("issues a new token on every login (no fixation, no reuse)", async () => {
    const first = await owner();
    const second = await auth.login("owner@example.com", PASSWORD, "127.0.0.1");
    expect(second.token).not.toBe(first.token);
    expect(second.session.id).not.toBe(first.session.id);
    expect(auth.resolve("attacker-chosen-session-value")).toBeUndefined();
  });

  it("slides idle expiry while used and stops at the absolute bound", async () => {
    const { token } = await owner();
    for (let hour = 0; hour < 3; hour++) {
      advance(50 * 60);
      expect(auth.resolve(token), `after ${hour + 1} uses`).toBeDefined();
    }
    advance(50 * 60); // 3h20 since login; idle ok, absolute 4h not yet
    expect(auth.resolve(token)).toBeDefined();
    advance(45 * 60); // 4h05: past the absolute bound although used 45 min ago
    expect(auth.resolve(token)).toBeUndefined();
  });

  it("expires after the idle bound without use", async () => {
    const { token } = await owner();
    advance(3599);
    expect(auth.resolve(token)).toBeDefined();
    advance(3600);
    expect(auth.resolve(token)).toBeUndefined();
  });

  it("logout revokes one session; logout-all revokes every session of the user", async () => {
    const a = await owner();
    const b = await auth.login("owner@example.com", PASSWORD, "127.0.0.1");
    auth.logout(a.session.id);
    expect(auth.resolve(a.token)).toBeUndefined();
    expect(auth.resolve(b.token)).toBeDefined();
    const c = await auth.login("owner@example.com", PASSWORD, "127.0.0.1");
    expect(auth.logoutAll(a.session.userId)).toBe(2);
    expect(auth.resolve(b.token)).toBeUndefined();
    expect(auth.resolve(c.token)).toBeUndefined();
  });

  it("password change rotates the current session and revokes the others", async () => {
    const a = await owner();
    const b = await auth.login("owner@example.com", PASSWORD, "127.0.0.1");
    const principal = auth.resolve(a.token)?.principal;
    if (!principal) throw new Error("no principal");
    await expect(
      auth.changePassword(principal, "wrong password!!", "another long password"),
    ).rejects.toThrow("Current password is incorrect");
    const rotated = await auth.changePassword(principal, PASSWORD, "another long password");
    expect(auth.resolve(a.token)).toBeUndefined();
    expect(auth.resolve(b.token)).toBeUndefined();
    expect(auth.resolve(rotated.token)).toBeDefined();
    await expect(auth.login("owner@example.com", PASSWORD, "127.0.0.2")).rejects.toThrow();
    await expect(
      auth.login("owner@example.com", "another long password", "127.0.0.2"),
    ).resolves.toBeDefined();
  });

  it("throttles guesses of the current password through a held session", async () => {
    const a = await owner();
    const principal = auth.resolve(a.token)?.principal;
    if (!principal) throw new Error("no principal");
    for (let i = 0; i < 5; i++)
      await expect(
        auth.changePassword(principal, `wrong guess ${i}!!`, "another long password"),
      ).rejects.toThrow("Current password is incorrect");
    await expect(auth.changePassword(principal, PASSWORD, "another long password")).rejects.toThrow(
      "Too many failed attempts",
    );
    // The shared budget also stops sign-in guesses for that login name.
    await expect(auth.login("owner@example.com", PASSWORD, "elsewhere")).rejects.toThrow(
      "Too many failed sign-in attempts",
    );
    advance(15 * 60);
    await expect(
      auth.changePassword(principal, PASSWORD, "another long password"),
    ).resolves.toBeDefined();
  });

  it("disabling a user stops every session; enabling does not resurrect them", async () => {
    const { token } = await owner();
    expect(auth.setUserDisabled("owner@example.com", true)).toBe(1);
    expect(auth.resolve(token)).toBeUndefined();
    auth.setUserDisabled("owner@example.com", false);
    expect(auth.resolve(token)).toBeUndefined();
  });
});

describe("tenant grants", () => {
  it("membership removal or demotion invalidates the grant issued under the old version", async () => {
    await owner();
    // Roles are per workspace (ADR-0031 decision 7): Mia is an Admin of this one.
    const workspace = new WorkspaceStore(db).create({ name: "w", sandboxProvider: "docker" });
    const member = await auth.createUser({
      loginName: "mia",
      displayName: "Mia",
      password: PASSWORD,
      role: "admin",
      workspaceId: workspace.id,
    });
    const session = await auth.login("mia", PASSWORD, "127.0.0.1");
    expect(auth.resolve(session.token)?.principal.role).toBe("admin");
    auth.users.updateMembership(DEFAULT_TENANT_ID, member.id, {
      role: "member",
      workspaceId: workspace.id,
    });
    expect(auth.resolve(session.token)).toBeUndefined();
    const again = await auth.login("mia", PASSWORD, "127.0.0.1");
    expect(auth.resolve(again.token)?.principal.role).toBe("member");
    auth.users.updateMembership(DEFAULT_TENANT_ID, member.id, { status: "removed" });
    expect(auth.resolve(again.token)).toBeUndefined();
    // A proven password with no tenant to enter gets the same answer as a wrong password.
    await expect(auth.login("mia", PASSWORD, "127.0.0.1")).rejects.toThrow(
      "Login name or password is incorrect",
    );
  });

  it("a suspended tenant or a policy change stops every grant", async () => {
    const { token } = await owner();
    db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").run(DEFAULT_TENANT_ID);
    expect(auth.resolve(token)).toBeUndefined();
    db.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(DEFAULT_TENANT_ID);
    expect(auth.resolve(token)).toBeDefined();
    db.prepare("UPDATE tenants SET auth_policy_version = auth_policy_version + 1 WHERE id = ?").run(
      DEFAULT_TENANT_ID,
    );
    expect(auth.resolve(token)).toBeUndefined();
  });

  it("an sso_required tenant admits no local login, even with no provider linked", async () => {
    await createOwner(auth, { loginName: "owner", displayName: "Owner", password: PASSWORD });
    db.prepare("UPDATE tenants SET auth_policy = 'sso_required' WHERE id = ?").run(
      DEFAULT_TENANT_ID,
    );
    await expect(auth.login("owner", PASSWORD, "127.0.0.1")).rejects.toThrow(
      "Login name or password is incorrect",
    );
  });

  it("evaluates each denial reason", () => {
    const tenant = {
      id: "t",
      name: "T",
      status: "active" as const,
      authPolicy: "local_or_sso" as const,
      authPolicyVersion: 2,
    };
    const membership = {
      tenantId: "t",
      userId: "u",
      role: "member" as const,
      status: "active" as const,
      authVersion: 3,
    };
    const grant = {
      id: "g",
      sessionId: "s",
      tenantId: "t",
      loginId: "l",
      provider: "local" as const,
      issuer: "local",
      policyVersion: 2,
      membershipAuthVersion: 3,
      authTime: "2026-10-05T00:00:00.000Z",
      expiresAt: "2026-10-06T00:00:00.000Z",
      revokedAt: null,
    };
    const at = new Date("2026-10-05T12:00:00.000Z");
    const check = (overrides: Partial<Parameters<typeof evaluateTenantAccess>[0]>) =>
      evaluateTenantAccess({ tenant, membership, grant, now: at, ...overrides });
    expect(check({})).toEqual({ ok: true });
    expect(check({ tenant: undefined })).toEqual({ ok: false, reason: "tenant_inactive" });
    expect(check({ membership: undefined })).toEqual({ ok: false, reason: "no_membership" });
    expect(check({ membership: { ...membership, status: "removed" } })).toEqual({
      ok: false,
      reason: "membership_inactive",
    });
    expect(check({ grant: undefined })).toEqual({ ok: false, reason: "no_grant" });
    expect(check({ grant: { ...grant, revokedAt: "x" } })).toEqual({
      ok: false,
      reason: "grant_revoked",
    });
    expect(check({ now: new Date("2026-10-07T00:00:00.000Z") })).toEqual({
      ok: false,
      reason: "grant_expired",
    });
    expect(check({ grant: { ...grant, policyVersion: 1 } })).toEqual({
      ok: false,
      reason: "grant_policy_stale",
    });
    expect(check({ grant: { ...grant, membershipAuthVersion: 2 } })).toEqual({
      ok: false,
      reason: "grant_membership_stale",
    });
    expect(check({ tenant: { ...tenant, authPolicy: "sso_required" } })).toEqual({
      ok: false,
      reason: "provider_not_allowed",
    });
  });
});
