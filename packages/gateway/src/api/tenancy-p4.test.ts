// T1: ADR-0022 P4 (test plan MIG-04, MIG-05, ROLE-02, INV-01 and the second-tenant gate). Real
// HTTP against a Gateway in `multi` mode unless a case needs otherwise. Each refusal is paired
// with the permitted operation succeeding, and checked for no side effect.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSRF_HEADER, SSO_ERROR_PARAM, TENANT_HEADER } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../auth/auth-service.js";
import { backupDatabase, manifestPath, restoreDatabase } from "../db/backup.js";
import { applyMigrations, listMigrationFiles } from "../db/migrate.js";
import { openDatabase } from "../db/open.js";
import { buildGateway } from "../index.js";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { FakeIdp } from "../test-support/fake-idp.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import {
  type Harness,
  TEST_OPERATOR_TOKEN,
  startHarness,
  testConfig,
  waitFor,
} from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { type TenantFixture, seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-p4-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function multi(overrides: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness({
    auth: FAST_AUTH,
    secretsKey: randomBytes(32).toString("base64"),
    tenancy: "multi",
    ...overrides,
  });
  cleanups.push(() => h.close());
  return h;
}

/** A browser signed in as `login`, optionally pinned to a tenant with the selector header. */
async function browser(h: Harness, login: string): Promise<BrowserJar> {
  const jar = new BrowserJar(h.baseUrl);
  expect((await jar.signIn(login)).status).toBe(200);
  return jar;
}

function inTenant(tenantId: string) {
  return { headers: { [TENANT_HEADER]: tenantId } };
}

describe("second-tenant gate and downgrade protection (MIG-05)", () => {
  it("single mode refuses a database that already holds a second tenant", () => {
    const dir = tempDir();
    const dbPath = join(dir, "gw.sqlite");
    const db = openDatabase(dbPath);
    new AuthService(db, FAST_AUTH).users.createTenant({ name: "Second" });
    db.close();
    expect(() =>
      buildGateway(testConfig({ dbPath, auth: FAST_AUTH }), new FakeProvider(), {
        startCron: false,
      }),
    ).toThrow(/2 tenants.*DESKMATES_TENANCY=multi/);
    const app = buildGateway(
      testConfig({ dbPath, auth: FAST_AUTH, tenancy: "multi" }),
      new FakeProvider(),
      { startCron: false },
    );
    cleanups.push(() => app.close());
  });

  it("multi mode refuses to start until its preflight passes", () => {
    expect(() =>
      buildGateway(
        testConfig({ auth: { ...FAST_AUTH, cookieMode: "insecure-dev" }, tenancy: "multi" }),
        new FakeProvider(),
        { startCron: false },
      ),
    ).toThrow(/GATEWAY_SESSION_COOKIE must be secure/);
  });

  it("a database migrated by a newer Gateway is refused, not served", () => {
    const db = openDatabase(":memory:");
    cleanups.push(() => {
      db.close();
    });
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
      "9999-from-the-future.sql",
      new Date().toISOString(),
    );
    expect(() => applyMigrations(db)).toThrow(/newer Gateway.*9999-from-the-future/);
  });

  it("keeps the operator credential in the Default Tenant, whatever it selects", async () => {
    const h = await multi();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const own = ctx.workspaces.create({ name: "default workspace", sandboxProvider: "docker" });
    const listed = await h.api<{ workspaces: Array<{ id: string }> }>("GET", "/api/workspaces");
    expect(listed.status).toBe(200);
    expect(listed.json.workspaces.map((w) => w.id)).toEqual([own.id]);
    expect((await h.api("GET", `/api/workspaces/${A.ids.workspace}`)).status).toBe(404);
    // A tenant selector does not move it: the credential names no person and no tenant.
    const selected = await fetch(`${h.baseUrl}/api/workspaces`, {
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}`, [TENANT_HEADER]: A.tenantId },
    });
    expect(JSON.stringify(await selected.json())).not.toContain(A.sentinel);
  });
});

describe("ROLE-02: membership changes stay in the tenant and keep an Owner", () => {
  async function team(h: Harness) {
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const add = async (login: string, role: "owner" | "admin" | "member", t: TenantFixture) =>
      ctx.auth.createUser({
        loginName: login,
        displayName: login,
        password: TEST_PASSWORD,
        role,
        tenantId: t.tenantId,
      });
    const admin = await add("aadmin", "admin", A);
    const member = await add("amember", "member", A);
    const bUser = await add("bmember", "member", B);
    return { ctx, A, B, admin, member, bUser };
  }

  it("lists only this tenant's members and treats another tenant's user as missing", async () => {
    const h = await multi();
    const { A, B, member, bUser } = await team(h);
    const jar = await browser(h, "aadmin");
    const listed = await jar.json<{ members: Array<{ userId: string }> }>("GET", "/api/members");
    expect(listed.status).toBe(200);
    const ids = listed.json.members.map((m) => m.userId);
    expect(ids).toContain(member.id);
    expect(ids).not.toContain(bUser.id);
    expect(ids).not.toContain(B.ownerUserId);
    const foreign = await jar.json("PATCH", `/api/members/${bUser.id}`, {
      body: { status: "removed" },
    });
    expect(foreign.status).toBe(404);
    expect(h.app.deskmates.ctx.auth.users.getMembership(B.tenantId, bUser.id)?.status).toBe(
      "active",
    );
    // A Member cannot use the member routes at all.
    const memberJar = await browser(h, "amember");
    expect((await memberJar.fetch("GET", "/api/members")).status).toBe(403);
  });

  it("an Admin manages Members and Guests and promotes to Admin, nothing above; an Owner manages everyone; the last Owner stays", async () => {
    const h = await multi();
    const { ctx, A, admin, member } = await team(h);
    const adminJar = await browser(h, "aadmin");
    // Granting Owner is the Owner's (ADR-0022 amendment 6 W3, W4).
    expect(
      (await adminJar.fetch("PATCH", `/api/members/${member.id}`, { body: { role: "owner" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await adminJar.fetch("PATCH", `/api/members/${A.ownerUserId}`, {
          body: { status: "removed" },
        })
      ).status,
    ).toBe(403);
    expect(ctx.auth.users.getMembership(A.tenantId, member.id)?.role).toBe("member");
    // The Owner promotes; the Admin may remove a Member.
    const ownerPatch = (userId: string, body: unknown) =>
      fetch(`${h.baseUrl}/api/members/${userId}`, {
        method: "PATCH",
        headers: {
          cookie: `${SESSION}=${A.token}`,
          origin: h.baseUrl,
          [CSRF_HEADER]: A.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await ownerPatch(admin.id, { role: "member" })).status).toBe(200);
    // A role change ends the changed person's grant for this tenant: they sign in again.
    expect((await adminJar.fetch("GET", "/api/members")).status).toBe(401);
    expect((await ownerPatch(admin.id, { role: "admin" })).status).toBe(200);
    const relogged = await browser(h, "aadmin");
    expect(
      (await relogged.fetch("PATCH", `/api/members/${member.id}`, { body: { status: "removed" } }))
        .status,
    ).toBe(200);
    expect((await ownerPatch(admin.id, { role: "owner" })).status).toBe(200);
    // Two Owners demoting each other at once: exactly one wins, an Owner always remains.
    const second = await browser(h, "aadmin");
    const results = await Promise.all([
      ownerPatch(admin.id, { role: "member" }),
      second.fetch("PATCH", `/api/members/${A.ownerUserId}`, { body: { role: "member" } }),
    ]);
    // The loser is refused either by the last-Owner rule (409) or because the winner's change
    // already ended its grant (401); never both succeed.
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 200).every((s) => s === 401 || s === 409)).toBe(true);
    // The rule itself, without the grant check in front of it.
    const remaining = ctx.auth
      .listMembers(A.tenantId)
      .find((m) => m.role === "owner" && m.status === "active");
    expect(() =>
      ctx.auth.users.updateMembership(A.tenantId, remaining?.userId as string, {
        role: "member",
        workspaceId: A.ids.workspace,
      }),
    ).toThrow(/last Owner/);
    const owners = ctx.auth
      .listMembers(A.tenantId)
      .filter((m) => m.role === "owner" && m.status === "active");
    expect(owners).toHaveLength(1);
  });

  it("an Admin decides the workspace's approvals, attributed to that person", async () => {
    const h = await multi();
    const { ctx, A, admin } = await team(h);
    // A Member answers only the approvals of runs they started (amendment 6 W5).
    expect(
      (
        await (
          await browser(h, "amember")
        ).fetch("POST", `/api/approvals/${A.ids.approval}/decide`, {
          body: { decision: "allow_once" },
        })
      ).status,
    ).toBe(403);
    const jar = await browser(h, "aadmin");
    const decided = await jar.fetch("POST", `/api/approvals/${A.ids.approval}/decide`, {
      body: { decision: "allow_once", authorId: "someone-else" },
    });
    expect(decided.status).toBe(200);
    expect(ctx.approvals.mustGet(A.ids.approval as never)).toMatchObject({
      decision: "allow_once",
      decidedBy: `human:user:${admin.id}`,
    });
  });

  it("removing a member closes that member's live stream in the tenant at once", async () => {
    const h = await multi();
    const { ctx, A, member } = await team(h);
    const { token } = await ctx.auth.login("amember", TEST_PASSWORD, "test");
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const stream = await fetch(`${h.baseUrl}/api/events`, {
      headers: { cookie: `${SESSION}=${token}` },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    let ended = false;
    void (async () => {
      try {
        for (;;) if ((await reader?.read())?.done) break;
      } catch {}
      ended = true;
    })();
    ctx.auth.changeMembership({ userId: A.ownerUserId, label: "test" }, A.tenantId, member.id, {
      status: "removed",
    });
    await waitFor(() => ended, 2000, "member stream closed");
  });
});

describe("INV-01: an invitation admits exactly its identity, once", () => {
  async function ownerOf(h: Harness) {
    const A = await seedTenant(h.app.deskmates.ctx, "A");
    const post = (path: string, body: unknown, method = "POST") =>
      fetch(`${h.baseUrl}${path}`, {
        method,
        headers: {
          cookie: `${SESSION}=${A.token}`,
          origin: h.baseUrl,
          [CSRF_HEADER]: A.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const invite = async (body: unknown) => {
      const res = await post("/api/invitations", body);
      return {
        status: res.status,
        json: (await res.json()) as { link: string; invitation: { id: string } },
      };
    };
    return { A, post, invite };
  }

  const tokenOf = (link: string) => link.slice("/#/invite/".length);

  async function acceptNew(h: Harness, token: string, extra: Record<string, unknown> = {}) {
    const jar = new BrowserJar(h.baseUrl);
    const anon = await jar.json<{ loginCsrf: string }>("GET", "/auth/session");
    const res = await jar.json<{ tenant?: { id: string; role: string } }>(
      "POST",
      "/auth/invitations/accept",
      {
        body: { token, displayName: "New Person", password: TEST_PASSWORD, ...extra },
        csrf: anon.json.loginCsrf,
      },
    );
    return { jar, ...res };
  }

  it("creates exactly the invited account with the invited role, once", async () => {
    const h = await multi();
    const { A, invite } = await ownerOf(h);
    const created = await invite({
      role: "member",
      target: { kind: "local_new", loginName: "newbie" },
    });
    expect(created.status).toBe(201);
    const token = tokenOf(created.json.link);
    // Only the hash is stored.
    expect(h.app.deskmates.ctx.db.serialize().toString("latin1")).not.toContain(token);
    const preview = await new BrowserJar(h.baseUrl).json<{ role: string; tenantName: string }>(
      "GET",
      `/auth/invitations/${token}`,
    );
    expect(preview.json).toMatchObject({ role: "member", tenantName: "Tenant A" });
    // A forged role in the acceptance is ignored; the stored role applies.
    const accepted = await acceptNew(h, token, { role: "owner", tenantId: "tnt_default" });
    expect(accepted.status).toBe(200);
    expect(accepted.json.tenant).toMatchObject({ id: A.tenantId, role: "member" });
    expect((await accepted.jar.fetch("GET", "/api/workspaces")).status).toBe(200);
    // Replayed: refused as used (410, ADR-0022 amendment 4 I6), nothing new.
    const users = h.app.deskmates.ctx.auth.users.userCount();
    expect((await acceptNew(h, token)).status).toBe(410);
    expect(h.app.deskmates.ctx.auth.users.userCount()).toBe(users);
  });

  it("two concurrent acceptances of one invitation create one account", async () => {
    const h = await multi();
    const { invite } = await ownerOf(h);
    const created = await invite({
      role: "member",
      target: { kind: "local_new", loginName: "racer" },
    });
    const token = tokenOf(created.json.link);
    const users = h.app.deskmates.ctx.auth.users.userCount();
    const results = await Promise.all([
      acceptNew(h, token),
      acceptNew(h, token),
      acceptNew(h, token),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(h.app.deskmates.ctx.auth.users.userCount()).toBe(users + 1);
  });

  it("refuses expired, revoked, unknown and foreign-tenant invitations", async () => {
    const h = await multi();
    const { post, invite } = await ownerOf(h);
    const B = await seedTenant(h.app.deskmates.ctx, "B");
    const expired = await invite({
      role: "member",
      target: { kind: "local_new", loginName: "late" },
      expiresInSeconds: 60,
    });
    h.app.deskmates.ctx.db
      .prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), expired.json.invitation.id);
    // A used, revoked or expired link says so (410, ADR-0022 amendment 4 I6).
    expect((await acceptNew(h, tokenOf(expired.json.link))).status).toBe(410);
    const revoked = await invite({
      role: "member",
      target: { kind: "local_new", loginName: "gone" },
    });
    expect(
      (await post(`/api/invitations/${revoked.json.invitation.id}`, {}, "DELETE")).status,
    ).toBe(200);
    expect((await acceptNew(h, tokenOf(revoked.json.link))).status).toBe(410);
    expect((await acceptNew(h, "x".repeat(43))).status).toBe(401);
    // No mail service and no signup route: an invitation is the only way in.
    expect(
      (await new BrowserJar(h.baseUrl).fetch("POST", "/auth/signup", { body: {} })).status,
    ).toBe(404);
    // B's Owner cannot see or revoke A's invitation.
    const bDelete = await fetch(`${h.baseUrl}/api/invitations/${revoked.json.invitation.id}`, {
      method: "DELETE",
      headers: { cookie: `${SESSION}=${B.token}`, origin: h.baseUrl, [CSRF_HEADER]: B.csrf },
    });
    expect(bDelete.status).toBe(404);
    const bList = await fetch(`${h.baseUrl}/api/invitations`, {
      headers: { cookie: `${SESSION}=${B.token}` },
    });
    expect(((await bList.json()) as { invitations: unknown[] }).invitations).toEqual([]);
  });

  it("an existing account accepts only its own invitation, from its own session", async () => {
    const h = await multi();
    const { A, invite } = await ownerOf(h);
    const ctx = h.app.deskmates.ctx;
    for (const login of ["bob", "carol"])
      await ctx.auth.createUser({
        loginName: login,
        displayName: login,
        password: TEST_PASSWORD,
        role: "member",
      });
    const created = await invite({
      role: "member",
      target: { kind: "local_user", loginName: "bob" },
    });
    const token = tokenOf(created.json.link);
    const carol = await browser(h, "carol");
    expect(
      (await carol.fetch("POST", "/auth/invitations/accept", { body: { token } })).status,
    ).toBe(401);
    const bob = await browser(h, "bob");
    expect((await bob.fetch("POST", "/auth/invitations/accept", { body: { token } })).status).toBe(
      200,
    );
    expect((await bob.fetch("GET", "/api/workspaces", inTenant(A.tenantId))).status).toBe(200);
    expect((await carol.fetch("GET", "/api/workspaces", inTenant(A.tenantId))).status).toBe(401);
    const session = await bob.json<{ tenants: Array<{ id: string; enterable: boolean }> }>(
      "GET",
      "/auth/session",
    );
    expect(session.json.tenants.map((t) => t.id).sort()).toEqual(
      [A.tenantId, "tnt_default"].sort(),
    );
  });

  it("an Admin or an Owner invites an Admin, never an Owner (amendment 6 W4)", async () => {
    const h = await multi();
    const { A, invite } = await ownerOf(h);
    await h.app.deskmates.ctx.auth.createUser({
      loginName: "aadmin",
      displayName: "Admin",
      password: TEST_PASSWORD,
      role: "admin",
      tenantId: A.tenantId,
    });
    const admin = await browser(h, "aadmin");
    const asAdmin = await admin.fetch("POST", "/api/invitations", {
      body: { role: "admin", target: { kind: "local_new", loginName: "x" } },
    });
    expect(asAdmin.status).toBe(201);
    expect(
      (await invite({ role: "admin", target: { kind: "local_new", loginName: "x2" } })).status,
    ).toBe(201);
    // Never an Owner by invitation.
    expect(
      (await invite({ role: "owner", target: { kind: "local_new", loginName: "y" } })).status,
    ).toBe(400);
  });

  it("an SSO invitation needs the IdP to assert the invited email as verified", async () => {
    const h = await multi();
    const { A, invite } = await ownerOf(h);
    const ctx = h.app.deskmates.ctx;
    const idp = await FakeIdp.start();
    cleanups.push(() => idp.close());
    ctx.oidc.store.addProvider({
      id: "corp",
      displayName: "Corp",
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      redirectUri: `${h.baseUrl}/auth/oidc/callback`,
    });
    // The provider must be one this tenant trusts.
    expect(
      (
        await invite({
          role: "admin",
          target: { kind: "oidc_email", providerId: "corp", email: "Dee@Corp.example" },
        })
      ).status,
    ).toBe(400);
    ctx.oidc.store.linkTenant(A.tenantId, "corp");
    const created = await invite({
      role: "admin",
      target: { kind: "oidc_email", providerId: "corp", email: "Dee@Corp.example" },
    });
    const token = tokenOf(created.json.link);
    const attempt = async (login: Parameters<FakeIdp["authorize"]>[1]) => {
      const jar = new BrowserJar(h.baseUrl);
      const anon = await jar.json<{ loginCsrf: string }>("GET", "/auth/session");
      const started = await jar.json<{ authorizationUrl: string }>(
        "POST",
        "/auth/oidc/corp/start",
        {
          body: { purpose: "login", invitation: token },
          csrf: anon.json.loginCsrf,
        },
      );
      if (started.status !== 200) return { status: started.status, error: null, jar };
      const back = new URL(idp.authorize(started.json.authorizationUrl, login));
      const res = await jar.fetch("GET", `${back.pathname}${back.search}`, { redirect: "manual" });
      const location = res.headers.get("location") ?? "";
      return {
        status: res.status,
        error: new URL(location, "http://x.invalid").searchParams.get(SSO_ERROR_PARAM),
        jar,
      };
    };
    const users = ctx.auth.users.userCount();
    expect(
      (await attempt({ sub: "dee", email: "dee@corp.example", emailVerified: false })).error,
    ).toBe("invitation_invalid");
    expect(
      (await attempt({ sub: "eve", email: "eve@corp.example", emailVerified: true })).error,
    ).toBe("invitation_invalid");
    expect(ctx.auth.users.userCount()).toBe(users);
    const ok = await attempt({ sub: "dee", email: "DEE@corp.example", emailVerified: true });
    expect(ok.error).toBeNull();
    const view = await ok.jar.json<{ tenant: { id: string; role: string } }>(
      "GET",
      "/auth/session",
      inTenant(A.tenantId),
    );
    expect(view.json.tenant).toMatchObject({ id: A.tenantId, role: "admin" });
    expect(ctx.auth.users.userCount()).toBe(users + 1);
    // Spent: the same link cannot start another sign-in.
    expect(
      (await attempt({ sub: "dee2", email: "dee@corp.example", emailVerified: true })).status,
    ).toBe(401);
  });
});

describe("MIG-04: backup and restore never resurrect authority", () => {
  it("backs up a live database coherently and restores it with every credential revoked", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "gateway.sqlite");
    const app = buildGateway(
      testConfig({ dbPath, auth: FAST_AUTH, secretsKey: randomBytes(32).toString("base64") }),
      new FakeProvider(),
      { startCron: false },
    );
    await app.ready();
    const ctx = app.deskmates.ctx;
    await createOwner(ctx.auth, {
      loginName: "owner",
      displayName: "Owner",
      password: TEST_PASSWORD,
    });
    const signedIn = await ctx.auth.login("owner", TEST_PASSWORD, "test");
    const workspace = ctx.workspaces.create({ name: "kept", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ name: "keeper", role: "r", workspaceId: workspace.id });
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "backup",
      triggerPayload: {},
      config: ctx.runConfig(),
    });
    const runToken = ctx.tokens.issue(run.id);
    const backup = join(dir, "backup.sqlite");
    // Taken while the Gateway is running and writing (WAL mode).
    const manifest = await backupDatabase(dbPath, backup);
    expect(manifest.tables.workspaces).toBe(1);
    expect(manifest.tables.auth_sessions).toBe(1);
    expect(manifest.migrations).toEqual(listMigrationFiles());
    await expect(backupDatabase(dbPath, backup)).rejects.toThrow(/already exists/);
    await app.close();

    // A tampered backup is refused before anything is touched.
    const tampered = join(dir, "tampered.sqlite");
    writeFileSync(tampered, readFileSync(backup));
    writeFileSync(manifestPath(tampered), readFileSync(manifestPath(backup)));
    writeFileSync(tampered, Buffer.concat([readFileSync(tampered), Buffer.from("x")]));
    expect(() => restoreDatabase(tampered, dbPath)).toThrow(/does not match/);
    expect(existsSync(dbPath)).toBe(true);

    const result = restoreDatabase(backup, dbPath);
    expect(result.sessionsRevoked).toBe(1);
    expect(result.runTokensRevoked).toBe(1);
    expect(result.previous && existsSync(result.previous)).toBe(true);
    const restored = buildGateway(testConfig({ dbPath, auth: FAST_AUTH }), new FakeProvider(), {
      startCron: false,
    });
    cleanups.push(() => restored.close());
    await restored.ready();
    const rctx = restored.deskmates.ctx;
    expect(rctx.workspaces.mustGet(workspace.id).name).toBe("kept");
    // The session and run token in the backup cannot act any more; signing in again works.
    expect(rctx.auth.resolve(signedIn.token)).toBeUndefined();
    expect(rctx.tokens.verify(runToken.token)).toBeUndefined();
    await expect(rctx.auth.login("owner", TEST_PASSWORD, "test")).resolves.toBeDefined();
  });
});
