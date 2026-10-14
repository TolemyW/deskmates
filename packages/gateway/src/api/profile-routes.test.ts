// T1: self-service account settings (ADR-0022 amendment 3, issue #26). A signed-in person changes
// their own display name and avatar; nothing in a request can name another account. The session
// view reports the avatar and an authoritative password capability.

import {
  AVATAR_MAX_BYTES,
  type AuthenticatedSessionView,
  CSRF_HEADER,
  type ProfileView,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { ROUTE_POLICY } from "./route-policy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

// Smallest valid signatures of each accepted type, padded so the body is not trivially short.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("....IHDR-png-body"),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from("WEBPVP8 webp-body"),
]);
const GIF = Buffer.from("GIF89a-not-accepted");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

interface World {
  h: Harness;
  owner: BrowserJar;
  member: BrowserJar;
  admin: BrowserJar;
  ids: { owner: string; member: string; admin: string };
}

async function world(): Promise<World> {
  const h = await startHarness({ auth: FAST_AUTH });
  cleanups.push(() => h.close());
  const auth = h.app.deskmates.ctx.auth;
  const owner = await createOwner(auth, {
    loginName: "owner",
    displayName: "Olive Owner",
    password: TEST_PASSWORD,
  });
  const member = await auth.createUser({
    loginName: "mia",
    displayName: "Mia Member",
    password: TEST_PASSWORD,
    role: "member",
  });
  const admin = await auth.createUser({
    loginName: "ada",
    displayName: "Ada Admin",
    password: TEST_PASSWORD,
    role: "admin",
  });
  const jars = {
    owner: new BrowserJar(h.baseUrl),
    member: new BrowserJar(h.baseUrl),
    admin: new BrowserJar(h.baseUrl),
  };
  expect((await jars.owner.signIn("owner")).status).toBe(200);
  expect((await jars.member.signIn("mia")).status).toBe(200);
  expect((await jars.admin.signIn("ada")).status).toBe(200);
  return { h, ...jars, ids: { owner: owner.id, member: member.id, admin: admin.id } };
}

async function session(jar: BrowserJar): Promise<AuthenticatedSessionView> {
  const { status, json } = await jar.json<AuthenticatedSessionView>("GET", "/auth/session");
  expect(status).toBe(200);
  return json;
}

/** Upload raw image bytes the way the settings page does. */
async function upload(
  jar: BrowserJar,
  bytes: Buffer,
  contentType: string,
  options: { csrf?: string | null; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": contentType,
    cookie: jar.cookieHeader(),
    origin: options.origin ?? jar.origin,
  };
  const csrf = options.csrf === undefined ? jar.csrf : options.csrf;
  if (csrf) headers[CSRF_HEADER] = csrf;
  return fetch(`${jar.baseUrl}/auth/avatar`, { method: "PUT", headers, body: bytes });
}

function displayNames(h: Harness): Record<string, string> {
  const rows = h.app.deskmates.ctx.db.prepare("SELECT id, display_name FROM users").all() as Array<{
    id: string;
    display_name: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.id, row.display_name]));
}

describe("account settings routes", () => {
  it("are guarded with the authenticated route policy", () => {
    for (const route of [
      "PATCH /auth/profile",
      "PUT /auth/avatar",
      "DELETE /auth/avatar",
      "GET /auth/avatar",
    ])
      expect(ROUTE_POLICY[route], route).toEqual({ access: "authenticated" });
  });

  it("each role changes only its own display name, which survives a new sign-in", async () => {
    const w = await world();
    const before = displayNames(w.h);
    const memberships = w.h.app.deskmates.ctx.db
      .prepare("SELECT * FROM tenant_memberships ORDER BY user_id")
      .all();
    for (const [jar, id, name] of [
      [w.member, w.ids.member, "Mia M."],
      [w.admin, w.ids.admin, "Ada A."],
      [w.owner, w.ids.owner, "Olive O."],
    ] as const) {
      const saved = await jar.json<ProfileView>("PATCH", "/auth/profile", {
        body: { displayName: `  ${name}  ` },
      });
      expect(saved.status, name).toBe(200);
      expect(saved.json).toEqual({ displayName: name, avatarUrl: null });
      const view = await session(jar);
      expect(view.user.displayName).toBe(name);
      expect(view.user.id).toBe(id);
    }
    const after = displayNames(w.h);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // Login names, memberships, roles and platform maintenance are untouched.
    const fresh = new BrowserJar(w.h.baseUrl);
    expect((await fresh.signIn("mia")).status).toBe(200);
    const again = await session(fresh);
    expect(again.user).toMatchObject({ displayName: "Mia M.", loginName: "mia" });
    expect(again.tenant.role).toBe("guest"); // no workspace exists: no workspace role (amendment 6 W1)
    expect(again.platformMaintainer).toBe(false);
    expect(
      w.h.app.deskmates.ctx.db.prepare("SELECT * FROM tenant_memberships ORDER BY user_id").all(),
    ).toEqual(memberships);
  });

  it("refuses an invalid display name and stores nothing", async () => {
    const w = await world();
    for (const displayName of ["", "   ", "x".repeat(129), "bad\u0000name", "tab\tname", 7, null]) {
      const response = await w.member.fetch("PATCH", "/auth/profile", { body: { displayName } });
      expect(response.status, JSON.stringify(displayName)).toBe(400);
    }
    expect((await session(w.member)).user.displayName).toBe("Mia Member");
  });

  it("refuses another user's id, unknown keys and a principal that is not a person", async () => {
    const w = await world();
    const before = displayNames(w.h);
    for (const body of [
      { displayName: "Hijack", userId: w.ids.owner },
      { displayName: "Hijack", id: w.ids.owner },
      { displayName: "Hijack", role: "owner" },
      { displayName: "Hijack", loginName: "owner" },
      [{ displayName: "Hijack" }],
    ]) {
      const response = await w.member.fetch("PATCH", "/auth/profile", { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(displayNames(w.h)).toEqual(before);

    const operator = await w.h.api<{ code: string; details: { reason?: string } }>(
      "PATCH",
      "/auth/profile",
      { displayName: "Operator" },
    );
    expect(operator.status).toBe(400);
    expect(operator.json.details.reason).toBe("no_user");
    const { token } = w.h.app.deskmates.ctx.auth.servicePrincipals.create(
      DEFAULT_TENANT_ID,
      { name: "ci-agent" },
      "test",
      "admin",
    );
    const service = await fetch(`${w.h.baseUrl}/auth/profile`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Service" }),
    });
    expect(service.status).toBe(400);
    expect(displayNames(w.h)).toEqual(before);
  });

  it("refuses a change without CSRF, from another origin, or with no credential", async () => {
    const w = await world();
    const body = { displayName: "Changed" };
    expect((await w.member.fetch("PATCH", "/auth/profile", { body, csrf: null })).status).toBe(403);
    expect(
      (await w.member.fetch("PATCH", "/auth/profile", { body, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await upload(w.member, PNG, "image/png", { csrf: null })).status).toBe(403);
    expect((await w.member.fetch("DELETE", "/auth/avatar", { csrf: null })).status).toBe(403);
    const anonymous = await fetch(`${w.h.baseUrl}/auth/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(anonymous.status).toBe(401);
    expect((await fetch(`${w.h.baseUrl}/auth/avatar`)).status).toBe(401);
    expect((await session(w.member)).user.displayName).toBe("Mia Member");
  });

  it("stores, serves and removes an avatar for its owner only", async () => {
    const w = await world();
    expect((await session(w.member)).user.avatarUrl).toBeNull();
    expect((await w.member.fetch("GET", "/auth/avatar")).status).toBe(404);
    const urls = new Set<string>();
    for (const [bytes, type] of [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ] as const) {
      const response = await upload(w.member, bytes, type);
      expect(response.status, type).toBe(200);
      const saved = (await response.json()) as ProfileView;
      expect(saved.avatarUrl).toMatch(/^\/auth\/avatar\?v=[0-9a-f]{16}$/);
      urls.add(saved.avatarUrl as string);
      expect((await session(w.member)).user.avatarUrl).toBe(saved.avatarUrl);
      const served = await w.member.fetch("GET", saved.avatarUrl as string);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe(type);
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("content-security-policy")).toContain("sandbox");
      expect(served.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
    }
    expect(urls.size).toBe(3);
    // Another person's session sees only their own (absent) avatar.
    expect((await w.owner.fetch("GET", "/auth/avatar")).status).toBe(404);
    expect((await session(w.owner)).user.avatarUrl).toBeNull();

    const removed = await w.member.json<ProfileView>("DELETE", "/auth/avatar");
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ displayName: "Mia Member", avatarUrl: null });
    expect((await session(w.member)).user.avatarUrl).toBeNull();
    expect((await w.member.fetch("GET", "/auth/avatar")).status).toBe(404);
  });

  it("refuses unsafe, mismatched or oversized images and keeps the previous one", async () => {
    const w = await world();
    expect((await upload(w.member, PNG, "image/png")).status).toBe(200);
    const kept = (await session(w.member)).user.avatarUrl;
    const oversized = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]);
    for (const [bytes, type, status] of [
      [GIF, "image/gif", 400],
      [SVG, "image/svg+xml", 400],
      [PNG, "image/jpeg", 400],
      [JPEG, "image/png", 400],
      [Buffer.from("plain text"), "image/webp", 400],
      [Buffer.alloc(0), "image/png", 400],
      [Buffer.from("{}"), "application/json", 400],
      [oversized, "image/png", 413],
    ] as const) {
      const response = await upload(w.member, bytes, type);
      expect(response.status, `${type} ${bytes.length}`).toBe(status);
    }
    expect((await session(w.member)).user.avatarUrl).toBe(kept);
    const served = await w.member.fetch("GET", "/auth/avatar");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("reports the password capability from the account, not the session", async () => {
    const w = await world();
    const view = await session(w.member);
    expect(view.account).toEqual({ localLoginName: "mia", password: "available" });
    const ctx = w.h.app.deskmates.ctx;
    // An SSO-only person: no local login, so the identity provider manages the password.
    const created = ctx.auth.users.createOidcUser({
      displayName: "Sam SSO",
      issuer: "https://idp.example",
      subject: "sam",
      email: null,
      emailVerified: false,
      tenantId: DEFAULT_TENANT_ID,
    });
    const opened = ctx.auth.sessions.create(created.user, created.login);
    const sso = new BrowserJar(w.h.baseUrl);
    sso.cookies.set("__Host-deskmates-session", opened.token);
    const ssoView = await session(sso);
    expect(ssoView.user.loginName).toBeNull();
    expect(ssoView.account).toEqual({ localLoginName: null, password: "identity_provider" });
    // The member links an IdP identity and signs in through it: the local password still exists.
    const member = ctx.auth.users.findLocalLogin("mia");
    const link = ctx.auth.users.addOidcLogin(member?.userId as string, {
      issuer: "https://idp.example",
      subject: "mia",
      email: null,
      emailVerified: false,
    });
    const memberUser = ctx.auth.users.getUser(member?.userId as string);
    if (!memberUser) throw new Error("member missing");
    const viaSso = ctx.auth.sessions.create(memberUser, link);
    const mixed = new BrowserJar(w.h.baseUrl);
    mixed.cookies.set("__Host-deskmates-session", viaSso.token);
    const mixedView = await session(mixed);
    expect(mixedView.user.loginName).toBeNull();
    expect(mixedView.account).toEqual({ localLoginName: "mia", password: "sign_in_with_password" });
  });
});
