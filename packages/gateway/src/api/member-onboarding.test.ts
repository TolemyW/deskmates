// T1: member onboarding (ADR-0022 amendment 4, issue #25). An open sign-up link lets the
// recipient choose their own username and password, atomically with joining; an Admin may
// instead create the account and receive a generated initial password exactly once. Issued
// `local_new` invitations stay valid, SSO-only tenants refuse local accounts, and a link holder
// learns why a link stopped working.

import { randomBytes } from "node:crypto";
import {
  type AuthenticatedSessionView,
  CSRF_HEADER,
  type CreatedAccountView,
  type CreatedInvitationView,
  TENANT_HEADER,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { InvitationStore } from "../auth/invitations.js";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { FIXTURE_PASSWORD, type TenantFixture, seedTenant } from "../test-support/tenants.js";
import { ROUTE_POLICY } from "./route-policy.js";

const SESSION = "__Host-deskmates-session";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function multi(): Promise<Harness> {
  const h = await startHarness({
    auth: FAST_AUTH,
    secretsKey: randomBytes(32).toString("base64"),
    tenancy: "multi",
  });
  cleanups.push(() => h.close());
  return h;
}

/** Calls as the tenant's Owner (or another fixture session) with cookie, Origin and CSRF. */
function as(h: Harness, who: { token: string; csrf: string }, tenantId?: string) {
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${h.baseUrl}${path}`, {
      method,
      headers: {
        cookie: `${SESSION}=${who.token}`,
        origin: h.baseUrl,
        [CSRF_HEADER]: who.csrf,
        ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : undefined) as T };
  };
}

const tokenOf = (link: string) => link.slice("/#/invite/".length);

async function signupLink(
  h: Harness,
  A: TenantFixture,
  role: "member" | "admin" = "member",
): Promise<string> {
  const created = await as(h, A, A.tenantId)<CreatedInvitationView>("POST", "/api/invitations", {
    role,
    target: { kind: "local_signup" },
  });
  expect(created.status).toBe(201);
  expect(created.json.invitation.target).toEqual({ kind: "local_signup" });
  return tokenOf(created.json.link);
}

/** An anonymous browser accepting a sign-up link with the fields it chose. */
async function signUp(h: Harness, token: string, fields: Record<string, unknown>) {
  const jar = new BrowserJar(h.baseUrl);
  const anon = await jar.json<{ loginCsrf: string }>("GET", "/auth/session");
  const res = await jar.json<
    AuthenticatedSessionView & { code?: string; details?: { reason?: string } }
  >("POST", "/auth/invitations/accept", {
    body: { token, displayName: "Nia New", password: TEST_PASSWORD, ...fields },
    csrf: anon.json.loginCsrf,
  });
  if (res.status === 200) jar.csrf = res.json.csrfToken;
  return { jar, ...res };
}

function invitationRow(h: Harness, token: string) {
  const store = new InvitationStore(h.app.deskmates.ctx.db);
  return store.inspect(token)?.invitation;
}

describe("invite by link (local_signup)", () => {
  it("a sign-up link lets the recipient choose their username, once", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const token = await signupLink(h, A);
    // Only the hash is stored, and no identity is reserved.
    expect(ctx.db.serialize().toString("latin1")).not.toContain(token);
    const row = ctx.db.prepare("SELECT target_kind, target_value FROM invitations").get() as {
      target_kind: string;
      target_value: string | null;
    };
    expect(row).toEqual({ target_kind: "local_signup", target_value: null });

    const preview = await new BrowserJar(h.baseUrl).json<{
      tenantName: string;
      role: string;
      target: unknown;
      expiresAt: string;
    }>("GET", `/auth/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({
      tenantName: "Tenant A",
      role: "member",
      target: { kind: "local_signup" },
    });
    expect(Date.parse(preview.json.expiresAt)).toBeGreaterThan(Date.now());

    // A forged role or tenant in the acceptance is ignored.
    const joined = await signUp(h, token, {
      loginName: "  Nia.New ",
      role: "owner",
      tenantId: DEFAULT_TENANT_ID,
    });
    expect(joined.status).toBe(200);
    expect(joined.json.tenant).toMatchObject({ id: A.tenantId, role: "member" });
    expect(joined.json.user).toMatchObject({ displayName: "Nia New", loginName: "nia.new" });
    expect(joined.json.account).toEqual({ localLoginName: "nia.new", password: "available" });
    expect((await joined.jar.fetch("GET", "/api/workspaces")).status).toBe(200);
    // The chosen username and password sign in.
    expect((await new BrowserJar(h.baseUrl).signIn("nia.new")).status).toBe(200);
    // Spent: a replay is refused and creates nothing.
    const users = ctx.auth.users.userCount();
    const replay = await signUp(h, token, { loginName: "someone-else" });
    expect(replay.status).toBe(410);
    expect(replay.json.details?.reason).toBe("used");
    expect(ctx.auth.users.userCount()).toBe(users);
  });

  it("a signed-in person joins with the account they have", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    await ctx.auth.createUser({
      loginName: "bea",
      displayName: "Bea",
      password: TEST_PASSWORD,
      role: "member",
    });
    const hashBefore = ctx.auth.users.passwordHash(
      ctx.auth.users.findLocalLogin("bea")?.id as string,
    );
    const token = await signupLink(h, A);
    const bea = new BrowserJar(h.baseUrl);
    expect((await bea.signIn("bea")).status).toBe(200);
    const users = ctx.auth.users.userCount();
    const joined = await bea.json<{ joined: boolean; tenantId: string }>(
      "POST",
      "/auth/invitations/accept",
      { body: { token } },
    );
    expect(joined.status).toBe(200);
    expect(joined.json).toEqual({ joined: true, tenantId: A.tenantId });
    expect(ctx.auth.users.userCount()).toBe(users);
    expect(
      ctx.auth.users.getMembership(
        A.tenantId,
        ctx.auth.users.findLocalLogin("bea")?.userId as string,
      )?.role,
    ).toBe("member");
    expect(ctx.auth.users.passwordHash(ctx.auth.users.findLocalLogin("bea")?.id as string)).toBe(
      hashBefore,
    );
    expect(
      (await bea.fetch("GET", "/api/workspaces", { headers: { [TENANT_HEADER]: A.tenantId } }))
        .status,
    ).toBe(200);
    // Without the session's CSRF token the join is refused.
    const other = await signupLink(h, A);
    expect(
      (await bea.fetch("POST", "/auth/invitations/accept", { body: { token: other }, csrf: null }))
        .status,
    ).toBe(403);
    expect(invitationRow(h, other)?.consumedAt).toBeNull();
  });

  it("defaults an omitted display name and preserves an explicit one", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const defaulted = await signUp(h, await signupLink(h, A), {
      loginName: "Default.Name",
      displayName: undefined,
    });
    expect(defaulted.status).toBe(200);
    expect(defaulted.json.user).toMatchObject({
      loginName: "default.name",
      displayName: "default.name",
    });
    const explicit = await signUp(h, await signupLink(h, A), {
      loginName: "named",
      displayName: "Named Person",
    });
    expect(explicit.status).toBe(200);
    expect(explicit.json.user).toMatchObject({ loginName: "named", displayName: "Named Person" });
  });

  it("refusals spend nothing and never touch an existing account", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    await ctx.auth.createUser({
      loginName: "taken",
      displayName: "Already Here",
      password: TEST_PASSWORD,
      role: "member",
    });
    const takenLogin = ctx.auth.users.findLocalLogin("taken");
    const hashBefore = ctx.auth.users.passwordHash(takenLogin?.id as string);
    const token = await signupLink(h, A);
    const users = ctx.auth.users.userCount();
    for (const [fields, status, reason] of [
      [{ loginName: "Bad Name!" }, 400, undefined],
      [{ loginName: "" }, 400, undefined],
      [{ loginName: "okname", password: "short" }, 400, undefined],
      [{ loginName: "okname", displayName: "   " }, 400, undefined],
      [{ loginName: "TAKEN" }, 409, "login_name_taken"],
    ] as const) {
      const res = await signUp(h, token, fields);
      expect(res.status, JSON.stringify(fields)).toBe(status);
      if (reason) expect(res.json.details?.reason).toBe(reason);
    }
    expect(ctx.auth.users.userCount()).toBe(users);
    expect(ctx.auth.users.passwordHash(takenLogin?.id as string)).toBe(hashBefore);
    expect(ctx.auth.users.getMembership(A.tenantId, takenLogin?.userId as string)).toBeUndefined();
    expect(invitationRow(h, token)?.consumedAt).toBeNull();
    // The same link still works once corrected.
    expect((await signUp(h, token, { loginName: "okname" })).status).toBe(200);
  });

  it("concurrent acceptances create one account", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const token = await signupLink(h, A);
    const users = ctx.auth.users.userCount();
    const results = await Promise.all(
      ["racer1", "racer2", "racer3"].map((loginName) => signUp(h, token, { loginName })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(ctx.auth.users.userCount()).toBe(users + 1);
  });

  it("a link holder learns why the link stopped working", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const owner = as(h, A, A.tenantId);
    const expired = await signupLink(h, A);
    ctx.db
      .prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), invitationRow(h, expired)?.id);
    const revoked = await signupLink(h, A);
    expect(
      (await owner("DELETE", `/api/invitations/${invitationRow(h, revoked)?.id}`)).status,
    ).toBe(200);
    const used = await signupLink(h, A);
    expect((await signUp(h, used, { loginName: "first" })).status).toBe(200);
    for (const [token, reason] of [
      [expired, "expired"],
      [revoked, "revoked"],
      [used, "used"],
    ] as const) {
      const preview = await new BrowserJar(h.baseUrl).json<{ details: { reason: string } }>(
        "GET",
        `/auth/invitations/${token}`,
      );
      expect(preview.status, reason).toBe(410);
      expect(preview.json.details.reason).toBe(reason);
      const accept = await signUp(h, token, { loginName: `late-${reason}` });
      expect(accept.status, reason).toBe(410);
    }
    // An unknown token keeps the uniform answer.
    expect(
      (await new BrowserJar(h.baseUrl).fetch("GET", `/auth/invitations/${"x".repeat(43)}`)).status,
    ).toBe(401);
  });

  it("an SSO-only tenant refuses local accounts", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    // Issued while local sign-in was allowed; the policy then changed.
    const token = await signupLink(h, A);
    ctx.auth.users.setTenantPolicy(A.tenantId, "sso_required");
    // The Owner's password session may no longer enter A, so creation is checked on the service.
    const users = ctx.auth.users.userCount();
    const accepted = await signUp(h, token, { loginName: "newbie" });
    expect(accepted.status).toBe(403);
    expect(accepted.json.details?.reason).toBe("sso_required");
    expect(ctx.auth.users.userCount()).toBe(users);
    expect(invitationRow(h, token)?.consumedAt).toBeNull();
    // Creation is refused in the store for both paths.
    expect(() =>
      ctx.auth.createInvitation(A.tenantId, {
        workspaceId: A.ids.workspace,
        role: "member",
        target: { kind: "local_signup" },
        createdBy: "test",
      }),
    ).toThrow(/single sign-on/);
    await expect(
      ctx.auth.createAccount({ userId: A.ownerUserId, label: "test" }, A.tenantId, {
        loginName: "direct",
        displayName: "Direct",
        role: "member",
        workspaceId: A.ids.workspace,
      }),
    ).rejects.toThrow(/single sign-on/);
    expect(ctx.auth.users.userCount()).toBe(users);
  });
});

describe("administrator-created accounts", () => {
  it("is an Admin route", () => {
    expect(ROUTE_POLICY["POST /api/accounts"]).toMatchObject({ access: "tenant", role: "admin" });
  });

  it("an Admin creates an account and sees its initial password once", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    await ctx.auth.createUser({
      loginName: "ada",
      displayName: "Ada Admin",
      password: FIXTURE_PASSWORD,
      role: "admin",
      tenantId: A.tenantId,
    });
    const { token } = await ctx.auth.login("ada", FIXTURE_PASSWORD, "test");
    const { csrfTokenFor } = await import("../auth/tokens.js");
    const admin = as(h, { token, csrf: csrfTokenFor(token) }, A.tenantId);
    const created = await admin<CreatedAccountView>("POST", "/api/accounts", {
      loginName: "Max.Member",
      displayName: "Max Member",
      role: "member",
    });
    expect(created.status).toBe(201);
    expect(created.json.member).toMatchObject({
      displayName: "Max Member",
      loginName: "max.member",
      role: "member",
      status: "active",
    });
    expect(created.json.loginName).toBe("max.member");
    const password = created.json.initialPassword;
    expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){4}$/);
    // Stored only as a hash; never in a later response.
    expect(ctx.db.serialize().toString("latin1")).not.toContain(password);
    const members = await admin<{ members: unknown[] }>("GET", "/api/members");
    expect(JSON.stringify(members.json)).not.toContain(password);
    const invitations = await admin<{ invitations: unknown[] }>("GET", "/api/invitations");
    expect(JSON.stringify(invitations.json)).not.toContain(password);
    // The recipient signs in with it and is a Member of A.
    const jar = new BrowserJar(h.baseUrl);
    expect((await jar.signIn("max.member", password)).status).toBe(200);
    const view = await jar.json<AuthenticatedSessionView>("GET", "/auth/session");
    expect(view.json.tenant).toMatchObject({ id: A.tenantId, role: "member" });
    // ...and replaces it in Account settings.
    const changed = await jar.fetch("POST", "/auth/password", {
      body: { currentPassword: password, newPassword: TEST_PASSWORD },
    });
    expect(changed.status).toBe(200);
    expect((await new BrowserJar(h.baseUrl).signIn("max.member", password)).status).toBe(401);
    expect((await new BrowserJar(h.baseUrl).signIn("max.member")).status).toBe(200);
  });

  it("defaults an account's omitted display name and preserves an explicit one", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const owner = as(h, A, A.tenantId);
    const defaulted = await owner<CreatedAccountView>("POST", "/api/accounts", {
      loginName: "Default.Member",
      role: "member",
    });
    expect(defaulted.status).toBe(201);
    expect(defaulted.json.member).toMatchObject({
      loginName: "default.member",
      displayName: "default.member",
    });
    const explicit = await owner<CreatedAccountView>("POST", "/api/accounts", {
      loginName: "named-member",
      displayName: "Named Member",
      role: "member",
    });
    expect(explicit.status).toBe(201);
    expect(explicit.json.member.displayName).toBe("Named Member");
  });

  it("role limits, existing usernames and tenants", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const owner = as(h, A, A.tenantId);
    await ctx.auth.createUser({
      loginName: "ada",
      displayName: "Ada Admin",
      password: FIXTURE_PASSWORD,
      role: "admin",
      tenantId: A.tenantId,
    });
    await ctx.auth.createUser({
      loginName: "mo",
      displayName: "Mo Member",
      password: FIXTURE_PASSWORD,
      role: "member",
      tenantId: A.tenantId,
    });
    const { csrfTokenFor } = await import("../auth/tokens.js");
    const session = async (login: string) => {
      const { token } = await ctx.auth.login(login, FIXTURE_PASSWORD, login);
      return as(h, { token, csrf: csrfTokenFor(token) }, A.tenantId);
    };
    const admin = await session("ada");
    const member = await session("mo");
    const users = ctx.auth.users.userCount();
    const body = (role: string, loginName = `new-${role}`) => ({
      loginName,
      displayName: "New Person",
      role,
    });
    expect((await member("POST", "/api/accounts", body("member"))).status).toBe(403);
    // An Admin may create Admins too (ADR-0022 amendment 6 W4); nobody creates an Owner.
    expect((await admin("POST", "/api/accounts", body("owner"))).status).toBe(400);
    expect((await owner("POST", "/api/accounts", body("owner"))).status).toBe(400);
    expect(
      (await owner("POST", "/api/accounts", { ...body("member"), loginName: "Bad!" })).status,
    ).toBe(400);
    expect(
      (await owner("POST", "/api/accounts", { ...body("member"), displayName: "" })).status,
    ).toBe(400);
    expect(ctx.auth.users.userCount()).toBe(users);
    // An existing username, even another tenant's, is refused and its password is unchanged.
    const existing = ctx.auth.users.findLocalLogin("ada");
    const hash = ctx.auth.users.passwordHash(existing?.id as string);
    const taken = await owner<{ details: { reason: string } }>(
      "POST",
      "/api/accounts",
      body("member", "ADA"),
    );
    expect(taken.status).toBe(409);
    expect(taken.json.details.reason).toBe("login_name_taken");
    expect(ctx.auth.users.passwordHash(existing?.id as string)).toBe(hash);
    expect(ctx.auth.users.userCount()).toBe(users);
    // An Owner creates an Admin; the account belongs to A only.
    const madeAdmin = await owner<CreatedAccountView>("POST", "/api/accounts", body("admin"));
    expect(madeAdmin.status).toBe(201);
    expect(madeAdmin.json.member.role).toBe("admin");
    const bMembers = await as(
      h,
      B,
      B.tenantId,
    )<{ members: Array<{ loginName: string | null }> }>("GET", "/api/members");
    expect(bMembers.json.members.map((m) => m.loginName)).not.toContain("new-admin");
    // No account is ever a platform maintainer.
    const userId = madeAdmin.json.member.userId;
    expect(ctx.auth.users.getUser(userId)?.platformRole).toBeNull();
  });
});
