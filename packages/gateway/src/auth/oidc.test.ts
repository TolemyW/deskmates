// T1: ADR-0022 decision 3, generic OIDC over real loopback HTTP against a fake IdP (test plan
// SSO-01..04). Every refusal is paired with the same flow succeeding, and checked for no side
// effect: no session cookie, no new session row, no new identity row, no tenant grant.

import { randomBytes } from "node:crypto";
import { SSO_ERROR_PARAM, TENANT_HEADER } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OIDC_LOGIN_STARTS_PER_ADDRESS } from "../api/auth-routes.js";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { FakeIdp, type FakeIdpLogin } from "../test-support/fake-idp.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { OIDC_MAX_OPEN_PRELOGIN_TRANSACTIONS } from "./oidc-store.js";
import { DEFAULT_TENANT_ID } from "./user-store.js";

const SESSION = "__Host-deskmates-session";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

interface World {
  h: Harness;
  idp: FakeIdp;
  providerId: string;
}

async function world(): Promise<World> {
  const h = await startHarness({
    auth: FAST_AUTH,
    secretsKey: randomBytes(32).toString("base64"),
  });
  cleanups.push(() => h.close());
  const idp = await FakeIdp.start();
  cleanups.push(() => idp.close());
  const providerId = "corp";
  addProvider(h, idp, providerId);
  return { h, idp, providerId };
}

function addProvider(h: Harness, idp: FakeIdp, id: string): void {
  h.app.deskmates.ctx.oidc.store.addProvider({
    id,
    displayName: `Corp SSO ${id}`,
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: `${h.baseUrl}/auth/oidc/callback`,
  });
}

function count(h: Harness, table: string): number {
  return (
    h.app.deskmates.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

async function localUser(h: Harness, loginName: string, tenantId = DEFAULT_TENANT_ID) {
  const auth = h.app.deskmates.ctx.auth;
  if (auth.setupRequired())
    return createOwner(auth, { loginName, displayName: loginName, password: TEST_PASSWORD });
  return auth.createUser({
    loginName,
    displayName: loginName,
    password: TEST_PASSWORD,
    role: "member",
    tenantId,
  });
}

/** Start a sign-in in this browser; returns the IdP authorization URL. */
async function startLogin(
  jar: BrowserJar,
  providerId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; url: string; json: unknown }> {
  const anonymous = await jar.json<{ loginCsrf: string }>("GET", "/auth/session");
  const started = await jar.json<{ authorizationUrl: string }>(
    "POST",
    `/auth/oidc/${providerId}/start`,
    { body: { purpose: "login", ...body }, csrf: anonymous.json.loginCsrf },
  );
  return { status: started.status, url: started.json?.authorizationUrl ?? "", json: started.json };
}

/** Follow the IdP's redirect back into the Gateway, as the browser would. */
async function callback(
  jar: BrowserJar,
  redirect: string,
): Promise<{ status: number; location: string }> {
  const url = new URL(redirect);
  const response = await jar.fetch("GET", `${url.pathname}${url.search}`, { redirect: "manual" });
  await response.text();
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

function ssoError(location: string): string | null {
  return new URL(location, "http://x.invalid").searchParams.get(SSO_ERROR_PARAM);
}

async function signInWithIdp(
  w: World,
  login: FakeIdpLogin,
  jar = new BrowserJar(w.h.baseUrl),
  body: Record<string, unknown> = {},
) {
  const started = await startLogin(jar, w.providerId, body);
  expect(started.status).toBe(200);
  const back = await callback(jar, w.idp.authorize(started.url, login));
  return { jar, ...back };
}

describe("SSO-01: code + PKCE authenticates issuer + subject", () => {
  it("signs a linked identity in, with S256 PKCE, state, nonce and the exact redirect URI", async () => {
    const w = await world();
    const user = await localUser(w.h, "olive");
    w.h.app.deskmates.ctx.auth.users.addOidcLogin(user.id, {
      issuer: w.idp.issuer,
      subject: "sub-olive",
      email: null,
      emailVerified: false,
    });
    const jar = new BrowserJar(w.h.baseUrl);
    const anonymous = await jar.json<{ ssoProviders: unknown[] }>("GET", "/auth/session");
    expect(anonymous.json.ssoProviders).toEqual([{ id: "corp", displayName: "Corp SSO corp" }]);
    const started = await startLogin(jar, "corp", { returnPath: "/#/tasks" });
    expect(started.status).toBe(200);
    const params = FakeIdp.params(started.url);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")?.length).toBeGreaterThan(20);
    expect(params.get("nonce")?.length).toBeGreaterThan(20);
    expect(params.get("redirect_uri")).toBe(`${w.h.baseUrl}/auth/oidc/callback`);
    expect(started.url).not.toContain(w.idp.clientSecret);
    const back = await callback(jar, w.idp.authorize(started.url, { sub: "sub-olive" }));
    expect(back).toEqual({ status: 303, location: "/#/tasks" });
    expect(jar.cookies.has(SESSION)).toBe(true);
    const session = await jar.json<{ authenticated: boolean; user: { id: string } }>(
      "GET",
      "/auth/session",
    );
    expect(session.json).toMatchObject({ authenticated: true, user: { id: user.id } });
    // No secret material is stored in the clear: the state is hashed, the session token hashed.
    const tx = w.h.app.deskmates.ctx.db
      .prepare("SELECT state_hash, consumed_at FROM oidc_login_transactions")
      .all() as Array<{ state_hash: string; consumed_at: string | null }>;
    expect(tx).toHaveLength(1);
    expect(tx[0]?.state_hash).not.toBe(params.get("state"));
    expect(tx[0]?.consumed_at).not.toBeNull();
  });

  it.each<[string, FakeIdpLogin["tamper"]]>([
    ["another issuer", { iss: "https://evil.example/idp" }],
    ["another audience", { aud: "someone-else" }],
    ["a signature from a key outside the JWKS", { rogueKey: true }],
    ["a nonce from another transaction", { nonce: "replayed-nonce" }],
    ["an expired ID token", { expiresIn: -120 }],
  ])("refuses %s without opening a session", async (_label, tamper = {}) => {
    const w = await world();
    const user = await localUser(w.h, "olive");
    w.h.app.deskmates.ctx.auth.users.addOidcLogin(user.id, {
      issuer: w.idp.issuer,
      subject: "sub-olive",
      email: null,
      emailVerified: false,
    });
    const before = count(w.h, "auth_sessions");
    const bad = await signInWithIdp(w, { sub: "sub-olive", tamper });
    expect(bad.status).toBe(303);
    expect(ssoError(bad.location)).toBe("rejected");
    expect(bad.jar.cookies.has(SESSION)).toBe(false);
    expect(count(w.h, "auth_sessions")).toBe(before);
    // Positive control: the same identity with an honest token signs in.
    const good = await signInWithIdp(w, { sub: "sub-olive" });
    expect(good.location).toBe("/");
    expect(good.jar.cookies.has(SESSION)).toBe(true);
  });

  it("refuses a wrong PKCE verifier, a replayed state and a replayed code", async () => {
    const w = await world();
    const user = await localUser(w.h, "olive");
    w.h.app.deskmates.ctx.auth.users.addOidcLogin(user.id, {
      issuer: w.idp.issuer,
      subject: "sub-olive",
      email: null,
      emailVerified: false,
    });
    const jar = new BrowserJar(w.h.baseUrl);
    // An attacker swaps in its own code challenge: the verifier the Gateway holds no longer fits.
    const started = await startLogin(jar, "corp");
    const swapped = new URL(started.url);
    swapped.searchParams.set("code_challenge", "A".repeat(43));
    const pkce = await callback(jar, w.idp.authorize(swapped.href, { sub: "sub-olive" }));
    expect(ssoError(pkce.location)).toBe("rejected");
    expect(jar.cookies.has(SESSION)).toBe(false);

    // A completed callback cannot be replayed: the state is single-use.
    const fresh = await startLogin(jar, "corp");
    const redirect = w.idp.authorize(fresh.url, { sub: "sub-olive" });
    expect((await callback(jar, redirect)).location).toBe("/");
    const sessions = count(w.h, "auth_sessions");
    const replay = await callback(new BrowserJar(w.h.baseUrl), redirect);
    expect(ssoError(replay.location)).toBe("invalid_state");
    const sameBrowserReplay = await callback(jar, redirect);
    expect(ssoError(sameBrowserReplay.location)).toBe("invalid_state");
    expect(count(w.h, "auth_sessions")).toBe(sessions);

    // An already used code under a new, valid state is refused by the IdP.
    const second = new BrowserJar(w.h.baseUrl);
    const next = await startLogin(second, "corp");
    const usedCode = new URL(redirect).searchParams.get("code") ?? "";
    const forged = new URL(`${w.h.baseUrl}/auth/oidc/callback`);
    forged.searchParams.set("code", usedCode);
    forged.searchParams.set("state", FakeIdp.params(next.url).get("state") ?? "");
    const codeReplay = await callback(second, forged.href);
    expect(ssoError(codeReplay.location)).toBe("rejected");
    expect(second.cookies.has(SESSION)).toBe(false);
  });

  it("binds the callback to the browser that started it (login CSRF / session swap)", async () => {
    const w = await world();
    const user = await localUser(w.h, "olive");
    w.h.app.deskmates.ctx.auth.users.addOidcLogin(user.id, {
      issuer: w.idp.issuer,
      subject: "sub-olive",
      email: null,
      emailVerified: false,
    });
    // An attacker starts a flow and lures a victim's browser to the attacker's callback URL.
    const attacker = new BrowserJar(w.h.baseUrl);
    const started = await startLogin(attacker, "corp");
    const redirect = w.idp.authorize(started.url, { sub: "sub-olive" });
    const victim = new BrowserJar(w.h.baseUrl);
    await victim.json("GET", "/auth/session");
    const swapped = await callback(victim, redirect);
    expect(ssoError(swapped.location)).toBe("invalid_state");
    expect(victim.cookies.has(SESSION)).toBe(false);
    // The consumed transaction cannot then be finished by its own browser either.
    expect(ssoError((await callback(attacker, redirect)).location)).toBe("invalid_state");
  });

  it("refuses open redirects, unknown providers, missing CSRF and cross-origin starts", async () => {
    const w = await world();
    const jar = new BrowserJar(w.h.baseUrl);
    for (const returnPath of [
      "//evil.example/",
      "https://evil.example/",
      "/\\evil.example",
      "javascript:alert(1)",
      "/ok\nx",
    ]) {
      const started = await startLogin(jar, "corp", { returnPath });
      expect(started.status, returnPath).toBe(400);
    }
    expect((await startLogin(jar, "nope")).status).toBe(404);
    // A request cannot name an issuer or discovery URL: unknown fields are ignored.
    const pinned = await startLogin(jar, "corp", { issuer: "https://evil.example" });
    expect(new URL(pinned.url).origin).toBe(new URL(w.idp.issuer).origin);
    const anonymous = await jar.json<{ loginCsrf: string }>("GET", "/auth/session");
    const noCsrf = await jar.fetch("POST", "/auth/oidc/corp/start", {
      body: { purpose: "login" },
      csrf: null,
    });
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await jar.fetch("POST", "/auth/oidc/corp/start", {
      body: { purpose: "login" },
      csrf: anonymous.json.loginCsrf,
      origin: "https://evil.example",
    });
    expect(crossOrigin.status).toBe(403);
    expect(count(w.h, "oidc_login_transactions")).toBe(1);
  });

  it("an IdP error or outage fails closed", async () => {
    const w = await world();
    const user = await localUser(w.h, "olive");
    w.h.app.deskmates.ctx.auth.users.addOidcLogin(user.id, {
      issuer: w.idp.issuer,
      subject: "sub-olive",
      email: null,
      emailVerified: false,
    });
    const jar = new BrowserJar(w.h.baseUrl);
    const started = await startLogin(jar, "corp");
    const state = FakeIdp.params(started.url).get("state") ?? "";
    const denied = await callback(
      jar,
      `${w.h.baseUrl}/auth/oidc/callback?error=access_denied&state=${state}`,
    );
    expect(ssoError(denied.location)).toBe("idp_error");

    // Down during the token exchange: refused, no session.
    const again = await startLogin(jar, "corp");
    const redirect = w.idp.authorize(again.url, { sub: "sub-olive" });
    w.idp.down = true;
    expect(ssoError((await callback(jar, redirect)).location)).toBe("rejected");
    expect(jar.cookies.has(SESSION)).toBe(false);

    // Down before discovery was ever fetched: start fails, nothing is cached, recovery works.
    w.h.app.deskmates.ctx.oidc.forget();
    const outage = await startLogin(jar, "corp");
    expect(outage.status).toBeGreaterThanOrEqual(500);
    w.idp.down = false;
    const recovered = await signInWithIdp(w, { sub: "sub-olive" }, jar);
    expect(recovered.location).toBe("/");
  });
});

describe("SSO-01: sign-in starts cannot grow storage without bound", () => {
  it("limits starts per client address, and open pre-login transactions overall", async () => {
    const w = await world();
    const ctx = w.h.app.deskmates.ctx;
    // Each start may come with a fresh pre-login cookie, so the address is what counts.
    for (let i = 0; i < OIDC_LOGIN_STARTS_PER_ADDRESS; i += 1)
      expect((await startLogin(new BrowserJar(w.h.baseUrl), w.providerId)).status).toBe(200);
    const refused = await startLogin(new BrowserJar(w.h.baseUrl), w.providerId);
    expect(refused.status).toBe(429);
    expect(refused.json).toMatchObject({ code: "rate_limited" });
    expect(count(w.h, "oidc_login_transactions")).toBe(OIDC_LOGIN_STARTS_PER_ADDRESS);
    // Behind it, the table holds a bounded number of open pre-login transactions.
    const transaction = {
      providerId: w.providerId,
      purpose: "login" as const,
      tenantId: null,
      sessionId: null,
      browserBindingHash: "b".repeat(64),
      codeVerifier: "verifier",
      nonce: "nonce",
      returnPath: "/",
      invitationId: null,
    };
    for (
      let i = count(w.h, "oidc_login_transactions");
      i < OIDC_MAX_OPEN_PRELOGIN_TRANSACTIONS;
      i += 1
    )
      ctx.oidc.store.createTransaction(transaction);
    expect(() => ctx.oidc.store.createTransaction(transaction)).toThrow(/too many sign-ins/);
    expect(count(w.h, "oidc_login_transactions")).toBe(OIDC_MAX_OPEN_PRELOGIN_TRANSACTIONS);
  });
});

describe("SSO-02: identities never auto-link", () => {
  it("a matching verified email does not sign in the local account", async () => {
    const w = await world();
    await localUser(w.h, "olive@example.com");
    const logins = count(w.h, "user_logins");
    const result = await signInWithIdp(w, {
      sub: "stranger",
      email: "olive@example.com",
      emailVerified: true,
    });
    expect(ssoError(result.location)).toBe("no_account");
    expect(result.jar.cookies.has(SESSION)).toBe(false);
    expect(count(w.h, "user_logins")).toBe(logins);
    expect(count(w.h, "users")).toBe(1);
  });

  it("the same subject at two issuers is two identities", async () => {
    const w = await world();
    const otherIdp = await FakeIdp.start("/other");
    cleanups.push(() => otherIdp.close());
    addProvider(w.h, otherIdp, "other");
    const users = w.h.app.deskmates.ctx.auth.users;
    const olive = await localUser(w.h, "olive");
    const bob = await localUser(w.h, "bob");
    users.addOidcLogin(olive.id, {
      issuer: w.idp.issuer,
      subject: "42",
      email: null,
      emailVerified: false,
    });
    users.addOidcLogin(bob.id, {
      issuer: otherIdp.issuer,
      subject: "42",
      email: null,
      emailVerified: false,
    });
    const viaCorp = await signInWithIdp(w, { sub: "42" });
    const oliveView = await viaCorp.jar.json<{ user: { id: string } }>("GET", "/auth/session");
    expect(oliveView.json.user.id).toBe(olive.id);
    const viaOther = await signInWithIdp(
      { ...w, idp: otherIdp, providerId: "other" },
      { sub: "42" },
    );
    const bobView = await viaOther.jar.json<{ user: { id: string } }>("GET", "/auth/session");
    expect(bobView.json.user.id).toBe(bob.id);
  });

  it("links an identity only from a freshly authenticated session, and never steals one", async () => {
    const w = await world();
    const olive = await localUser(w.h, "olive");
    const bob = await localUser(w.h, "bob");
    const other = new BrowserJar(w.h.baseUrl);
    expect((await other.signIn("olive")).status).toBe(200);
    const jar = new BrowserJar(w.h.baseUrl);
    expect((await jar.signIn("olive")).status).toBe(200);
    const started = await jar.json<{ authorizationUrl: string }>("POST", "/auth/oidc/corp/start", {
      body: { purpose: "link", returnPath: "/#/settings" },
    });
    expect(started.status).toBe(200);
    expect(FakeIdp.params(started.json.authorizationUrl).get("prompt")).toBe("login");
    const linked = await callback(
      jar,
      w.idp.authorize(started.json.authorizationUrl, { sub: "olive-sub" }),
    );
    expect(linked.location).toBe("/#/settings");
    expect(
      w.h.app.deskmates.ctx.auth.users.findLogin("oidc", w.idp.issuer, "olive-sub")?.userId,
    ).toBe(olive.id);
    // Adding a login method ends the other sessions and keeps this one.
    expect((await other.json("GET", "/auth/session")).json).toMatchObject({ authenticated: false });
    expect((await jar.json("GET", "/auth/session")).json).toMatchObject({ authenticated: true });
    // The linked identity now signs Olive in.
    const viaSso = await signInWithIdp(w, { sub: "olive-sub" });
    const view = await viaSso.jar.json<{ user: { id: string } }>("GET", "/auth/session");
    expect(view.json.user.id).toBe(olive.id);

    // Bob cannot link Olive's identity to himself.
    const bobJar = new BrowserJar(w.h.baseUrl);
    expect((await bobJar.signIn("bob")).status).toBe(200);
    const bobStart = await bobJar.json<{ authorizationUrl: string }>(
      "POST",
      "/auth/oidc/corp/start",
      { body: { purpose: "link" } },
    );
    const stolen = await callback(
      bobJar,
      w.idp.authorize(bobStart.json.authorizationUrl, { sub: "olive-sub" }),
    );
    expect(ssoError(stolen.location)).toBe("identity_in_use");
    expect(w.h.app.deskmates.ctx.auth.users.loginsOf(bob.id).map((l) => l.provider)).toEqual([
      "local",
    ]);

    // A session that authenticated long ago must sign in again first.
    w.h.app.deskmates.ctx.db
      .prepare("UPDATE auth_sessions SET authenticated_at = ? WHERE user_id = ?")
      .run(new Date(Date.now() - 3600_000).toISOString(), bob.id);
    const stale = await bobJar.json<{ details: { reason: string } }>(
      "POST",
      "/auth/oidc/corp/start",
      { body: { purpose: "link" } },
    );
    expect(stale.status).toBe(403);
    expect(stale.json.details.reason).toBe("reauth_required");
    // Linking needs the session's CSRF token.
    const noCsrf = await bobJar.fetch("POST", "/auth/oidc/corp/start", {
      body: { purpose: "link" },
      csrf: null,
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("SSO-03: an SSO-enforced tenant admits only its own issuer, at the current policy", () => {
  async function enforced(w: World) {
    const ctx = w.h.app.deskmates.ctx;
    const olive = await localUser(w.h, "olive");
    const tenantB = ctx.auth.users.createTenant({ name: "Tenant B" });
    ctx.auth.users.addMembership(tenantB.id, olive.id, "admin");
    ctx.oidc.store.linkTenant(tenantB.id, w.providerId, { maxAuthAgeSeconds: 3600 });
    ctx.auth.users.setTenantPolicy(tenantB.id, "sso_required");
    ctx.auth.users.addOidcLogin(olive.id, {
      issuer: w.idp.issuer,
      subject: "olive-sub",
      email: null,
      emailVerified: false,
    });
    const jar = new BrowserJar(w.h.baseUrl);
    expect((await jar.signIn("olive")).status).toBe(200);
    const inB = () =>
      jar.fetch("GET", "/api/workspaces", { headers: { [TENANT_HEADER]: tenantB.id } });
    return { ctx, olive, tenantB, jar, inB };
  }

  async function stepUp(w: World, jar: BrowserJar, tenantId: string, login: FakeIdpLogin) {
    const started = await jar.json<{ authorizationUrl: string }>(
      "POST",
      `/auth/oidc/${w.providerId}/start`,
      { body: { purpose: "tenant_grant", tenantId, returnPath: "/#/home" } },
    );
    if (started.status !== 200) return { status: started.status, location: "" };
    return callback(jar, w.idp.authorize(started.json.authorizationUrl, login));
  }

  it("local login enters the Default Tenant but not B; a step-up with B's issuer does", async () => {
    const w = await world();
    const { tenantB, jar, inB } = await enforced(w);
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(200);
    expect((await inB()).status).toBe(401);
    const started = await jar.json<{ authorizationUrl: string }>("POST", "/auth/oidc/corp/start", {
      body: { purpose: "tenant_grant", tenantId: tenantB.id },
    });
    expect(FakeIdp.params(started.json.authorizationUrl).get("max_age")).toBe("3600");
    const granted = await callback(
      jar,
      w.idp.authorize(started.json.authorizationUrl, { sub: "olive-sub" }),
    );
    expect(granted).toEqual({ status: 303, location: "/" });
    expect((await inB()).status).toBe(200);
  });

  it("another tenant's issuer, an unlinked identity or a local password cannot enter B", async () => {
    const w = await world();
    const { ctx, olive, tenantB, jar, inB } = await enforced(w);
    // Provider "a" is trusted by tenant A only.
    const idpA = await FakeIdp.start("/a");
    cleanups.push(() => idpA.close());
    addProvider(w.h, idpA, "a");
    const tenantA = ctx.auth.users.createTenant({ name: "Tenant A" });
    ctx.oidc.store.linkTenant(tenantA.id, "a");
    ctx.auth.users.addOidcLogin(olive.id, {
      issuer: idpA.issuer,
      subject: "olive-a",
      email: null,
      emailVerified: false,
    });
    const viaA = await jar.fetch("POST", "/auth/oidc/a/start", {
      body: { purpose: "tenant_grant", tenantId: tenantB.id },
    });
    expect(viaA.status).toBe(404);
    // A full sign-in with A's issuer yields no grant for B either.
    const aJar = new BrowserJar(w.h.baseUrl);
    const signedInViaA = await signInWithIdp(
      { h: w.h, idp: idpA, providerId: "a" },
      { sub: "olive-a" },
      aJar,
    );
    expect(signedInViaA.location).toBe("/");
    expect(
      (await aJar.fetch("GET", "/api/workspaces", { headers: { [TENANT_HEADER]: tenantB.id } }))
        .status,
    ).toBe(401);
    // B's issuer, but a subject that is not Olive's: refused, no grant.
    const wrongSubject = await stepUp(w, jar, tenantB.id, { sub: "mallory-sub" });
    expect(ssoError(wrongSubject.location)).toBe("not_linked");
    expect((await inB()).status).toBe(401);
    // A member of only B, with a password, cannot sign in at all: no tenant admits local login.
    const onlyB = await ctx.auth.createUser({
      loginName: "bonly",
      displayName: "B only",
      password: TEST_PASSWORD,
      role: "member",
      tenantId: tenantB.id,
    });
    expect(onlyB.id).toBeTruthy();
    expect((await new BrowserJar(w.h.baseUrl).signIn("bonly")).status).toBe(401);
    const grants = ctx.db
      .prepare("SELECT provider, issuer FROM tenant_auth_grants WHERE tenant_id = ?")
      .all(tenantB.id);
    expect(grants).toEqual([]);
  });

  it("a policy change, an unlink, a disabled provider or an old IdP login end the grant", async () => {
    const w = await world();
    const { ctx, tenantB, jar, inB } = await enforced(w);
    const grant = async () => {
      expect((await stepUp(w, jar, tenantB.id, { sub: "olive-sub" })).location).toBe("/#/home");
      expect((await inB()).status).toBe(200);
    };
    await grant();
    ctx.auth.users.setTenantPolicy(tenantB.id, "sso_required"); // re-saved: version bump
    expect((await inB()).status).toBe(401);
    await grant();
    ctx.oidc.store.unlinkTenant(tenantB.id, w.providerId);
    expect((await inB()).status).toBe(401);
    ctx.oidc.store.linkTenant(tenantB.id, w.providerId, { maxAuthAgeSeconds: 3600 });
    await grant();
    ctx.oidc.store.setProviderStatus(w.providerId, "disabled");
    expect((await inB()).status).toBe(401);
    ctx.oidc.store.setProviderStatus(w.providerId, "active");
    await grant();
    // Shortening the maximum authentication age applies to grants already issued.
    ctx.oidc.store.linkTenant(tenantB.id, w.providerId, { maxAuthAgeSeconds: 1 });
    ctx.db
      .prepare("UPDATE tenant_auth_grants SET auth_time = ? WHERE tenant_id = ?")
      .run(new Date(Date.now() - 600_000).toISOString(), tenantB.id);
    expect((await inB()).status).toBe(401);
    // An IdP session older than the tenant's age bound is refused at the callback.
    ctx.oidc.store.linkTenant(tenantB.id, w.providerId, { maxAuthAgeSeconds: 60 });
    const old = await stepUp(w, jar, tenantB.id, {
      sub: "olive-sub",
      authTime: Math.floor(Date.now() / 1000) - 600,
    });
    expect(ssoError(old.location)).toBe("rejected");
    expect((await inB()).status).toBe(401);
  });

  it("an SSO sign-in without auth_time does not count as fresh; a step-up must prove it", async () => {
    const w = await world();
    const { tenantB } = await enforced(w);
    // The IdP authenticated two days ago and leaves auth_time out of the ID token.
    const { jar, location } = await signInWithIdp(w, {
      sub: "olive-sub",
      authTime: Math.floor(Date.now() / 1000) - 2 * 86_400,
      tamper: { omitAuthTime: true },
    });
    expect(ssoError(location)).toBeNull();
    jar.csrf = (await jar.json<{ csrfToken: string }>("GET", "/auth/session")).json.csrfToken;
    const inB = () =>
      jar.fetch("GET", "/api/workspaces", { headers: { [TENANT_HEADER]: tenantB.id } });
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(200);
    expect((await inB()).status).toBe(401);
    // A step-up asks for max_age, so a token without auth_time is refused there too.
    const missing = await stepUp(w, jar, tenantB.id, {
      sub: "olive-sub",
      tamper: { omitAuthTime: true },
    });
    expect(ssoError(missing.location)).toBe("rejected");
    expect((await inB()).status).toBe(401);
    expect((await stepUp(w, jar, tenantB.id, { sub: "olive-sub" })).location).toBe("/#/home");
    expect((await inB()).status).toBe(200);
  });

  it("JIT creates at most a Member, only where the tenant allows it", async () => {
    const w = await world();
    const ctx = w.h.app.deskmates.ctx;
    await localUser(w.h, "olive");
    const jitTenant = ctx.auth.users.createTenant({ name: "JIT" });
    ctx.oidc.store.linkTenant(jitTenant.id, w.providerId, { jitRole: "member" });
    ctx.auth.users.setTenantPolicy(jitTenant.id, "sso_required");
    const closedTenant = ctx.auth.users.createTenant({ name: "Closed" });
    ctx.oidc.store.linkTenant(closedTenant.id, w.providerId);
    expect(() =>
      ctx.oidc.store.linkTenant(closedTenant.id, w.providerId, {
        jitRole: "owner" as unknown as "member",
      }),
    ).toThrow(/Members/);

    const users = count(w.h, "users");
    const closed = await signInWithIdp(w, { sub: "newcomer" }, undefined, {
      tenantId: closedTenant.id,
    });
    expect(ssoError(closed.location)).toBe("no_account");
    expect(count(w.h, "users")).toBe(users);
    const unlinkedTarget = await startLogin(new BrowserJar(w.h.baseUrl), "corp", {
      tenantId: DEFAULT_TENANT_ID,
    });
    expect(unlinkedTarget.status).toBe(404);

    const joined = await signInWithIdp(
      w,
      { sub: "newcomer", name: "New Comer", email: "boss@example.com", emailVerified: true },
      undefined,
      { tenantId: jitTenant.id },
    );
    expect(joined.location).toBe("/");
    const view = await joined.jar.json<{
      tenant: { id: string; role: string };
      user: { displayName: string };
    }>("GET", "/auth/session");
    expect(view.json.tenant).toMatchObject({ id: jitTenant.id, role: "guest" }); // JIT grants no workspace role (ADR-0022 amendment 6 W1);
    expect(view.json.user.displayName).toBe("New Comer");
    expect(count(w.h, "users")).toBe(users + 1);
  });

  it("a later SSO sign-in keeps a locally edited display name (ADR-0022 amendment 3 P4)", async () => {
    const w = await world();
    const ctx = w.h.app.deskmates.ctx;
    await localUser(w.h, "olive");
    const jitTenant = ctx.auth.users.createTenant({ name: "JIT" });
    ctx.oidc.store.linkTenant(jitTenant.id, w.providerId, { jitRole: "member" });
    const first = await signInWithIdp(w, { sub: "sam", name: "Sam From IdP" }, undefined, {
      tenantId: jitTenant.id,
    });
    expect(first.location).toBe("/");
    const seeded = await first.jar.json<{
      user: { displayName: string; loginName: string | null };
      account: { localLoginName: string | null; password: string };
      csrfToken: string;
    }>("GET", "/auth/session");
    expect(seeded.json.user.displayName).toBe("Sam From IdP");
    // SSO-only: the identity provider manages the password, whatever the session says.
    expect(seeded.json.account).toEqual({ localLoginName: null, password: "identity_provider" });
    first.jar.csrf = seeded.json.csrfToken;
    const saved = await first.jar.fetch("PATCH", "/auth/profile", {
      body: { displayName: "Sam Local" },
      headers: { [TENANT_HEADER]: jitTenant.id },
    });
    expect(saved.status).toBe(200);

    const again = await signInWithIdp(w, { sub: "sam", name: "Renamed At IdP" }, undefined, {
      tenantId: jitTenant.id,
    });
    expect(again.location).toBe("/");
    const view = await again.jar.json<{ user: { displayName: string } }>("GET", "/auth/session");
    expect(view.json.user.displayName).toBe("Sam Local");
  });

  it("a sign-in from the page joins the only tenant that allows JIT, and none when ambiguous", async () => {
    const w = await world();
    const ctx = w.h.app.deskmates.ctx;
    const users = count(w.h, "users");
    // No tenant allows JIT for this provider: a stranger from the sign-in page has no account.
    ctx.oidc.store.linkTenant(DEFAULT_TENANT_ID, w.providerId);
    const nobody = await signInWithIdp(w, { sub: "stranger" });
    expect(ssoError(nobody.location)).toBe("no_account");
    expect(count(w.h, "users")).toBe(users);

    // Exactly one does: the sign-in page (which names no tenant) is a sign-in for that tenant.
    const jitTenant = ctx.auth.users.createTenant({ name: "JIT" });
    ctx.oidc.store.linkTenant(jitTenant.id, w.providerId, { jitRole: "member" });
    const joined = await signInWithIdp(w, { sub: "stranger", name: "A Stranger" });
    expect(joined.location).toBe("/");
    const view = await joined.jar.json<{ tenant: { id: string; role: string } }>(
      "GET",
      "/auth/session",
    );
    expect(view.json.tenant).toMatchObject({ id: jitTenant.id, role: "guest" }); // JIT grants no workspace role (ADR-0022 amendment 6 W1);
    expect(count(w.h, "users")).toBe(users + 1);

    // Two do: the target is ambiguous, so a further stranger needs an invitation.
    const second = ctx.auth.users.createTenant({ name: "JIT too" });
    ctx.oidc.store.linkTenant(second.id, w.providerId, { jitRole: "member" });
    const ambiguous = await signInWithIdp(w, { sub: "another-stranger" });
    expect(ssoError(ambiguous.location)).toBe("no_account");
    expect(count(w.h, "users")).toBe(users + 1);
    // A suspended JIT tenant no longer counts, so the remaining one is the target again.
    ctx.auth.users.setTenantStatus(second.id, "suspended");
    const afterSuspend = await signInWithIdp(w, { sub: "another-stranger" });
    expect(afterSuspend.location).toBe("/");
    expect(count(w.h, "users")).toBe(users + 2);
  });
});

describe("SSO-04: key rotation and bounded reauthentication", () => {
  it("accepts tokens signed with a rotated key and still refuses keys outside the JWKS", async () => {
    const w = await world();
    const user = await localUser(w.h, "olive");
    w.h.app.deskmates.ctx.auth.users.addOidcLogin(user.id, {
      issuer: w.idp.issuer,
      subject: "sub-olive",
      email: null,
      emailVerified: false,
    });
    expect((await signInWithIdp(w, { sub: "sub-olive" })).location).toBe("/");
    await w.idp.rotateKey();
    // Within the library's 60 s refetch cooldown a token with an unknown key id is refused, not
    // trusted: rotation can only ever fail closed.
    const early = await signInWithIdp(w, { sub: "sub-olive" });
    expect(ssoError(early.location)).toBe("rejected");
    // After the cooldown the new JWKS is fetched and the rotated key verifies, with no restart.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    try {
      expect((await signInWithIdp(w, { sub: "sub-olive" })).location).toBe("/");
      const rogue = await signInWithIdp(w, { sub: "sub-olive", tamper: { rogueKey: true } });
      expect(ssoError(rogue.location)).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
    // Discovery is fetched once and reused.
    expect(w.idp.discoveryCount).toBe(1);
  });

  it("a step-up grant expires at the IdP auth time plus the tenant's age bound", async () => {
    const w = await world();
    const ctx = w.h.app.deskmates.ctx;
    const olive = await localUser(w.h, "olive");
    const tenantB = ctx.auth.users.createTenant({ name: "Tenant B" });
    ctx.auth.users.addMembership(tenantB.id, olive.id, "member");
    ctx.oidc.store.linkTenant(tenantB.id, w.providerId, { maxAuthAgeSeconds: 900 });
    ctx.auth.users.setTenantPolicy(tenantB.id, "sso_required");
    ctx.auth.users.addOidcLogin(olive.id, {
      issuer: w.idp.issuer,
      subject: "olive-sub",
      email: null,
      emailVerified: false,
    });
    const jar = new BrowserJar(w.h.baseUrl);
    await jar.signIn("olive");
    const authTime = Math.floor(Date.now() / 1000) - 100;
    const started = await jar.json<{ authorizationUrl: string }>("POST", "/auth/oidc/corp/start", {
      body: { purpose: "tenant_grant", tenantId: tenantB.id },
    });
    await callback(
      jar,
      w.idp.authorize(started.json.authorizationUrl, { sub: "olive-sub", authTime }),
    );
    const grant = ctx.db
      .prepare(
        "SELECT auth_time, expires_at, provider, issuer FROM tenant_auth_grants WHERE tenant_id = ?",
      )
      .get(tenantB.id) as {
      auth_time: string;
      expires_at: string;
      provider: string;
      issuer: string;
    };
    expect(grant.provider).toBe("oidc");
    expect(grant.issuer).toBe(w.idp.issuer);
    expect(Date.parse(grant.auth_time)).toBe(authTime * 1000);
    expect(Date.parse(grant.expires_at)).toBe((authTime + 900) * 1000);
  });
});

describe("SSO-04: back-channel logout", () => {
  async function setup() {
    const w = await world();
    const ctx = w.h.app.deskmates.ctx;
    const olive = await localUser(w.h, "olive");
    ctx.auth.users.addOidcLogin(olive.id, {
      issuer: w.idp.issuer,
      subject: "olive-sub",
      email: null,
      emailVerified: false,
    });
    const viaIdp = async (sid: string) => {
      const result = await signInWithIdp(w, { sub: "olive-sub", sid });
      expect(result.location).toBe("/");
      return result.jar;
    };
    const logout = (token: string, provider = w.providerId) =>
      fetch(`${w.h.baseUrl}/auth/oidc/${provider}/backchannel-logout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ logout_token: token }).toString(),
      });
    const signedIn = async (jar: BrowserJar) =>
      (await jar.json<{ authenticated: boolean }>("GET", "/auth/session")).json.authenticated;
    return { w, ctx, olive, viaIdp, logout, signedIn };
  }

  it("ends exactly the IdP session a `sid` names, then every session of a `sub`", async () => {
    const { w, viaIdp, logout, signedIn } = await setup();
    const first = await viaIdp("idp-session-1");
    const second = await viaIdp("idp-session-2");
    const local = new BrowserJar(w.h.baseUrl);
    expect((await local.signIn("olive")).status).toBe(200);
    const bySid = await logout(await w.idp.logoutToken({ sid: "idp-session-1" }));
    expect(bySid.status).toBe(200);
    expect(bySid.headers.get("cache-control")).toBe("no-store");
    expect(await signedIn(first)).toBe(false);
    expect(await signedIn(second)).toBe(true);
    // A password session is not an IdP session: it stays.
    expect(await signedIn(local)).toBe(true);
    const bySub = await logout(await w.idp.logoutToken({ sub: "olive-sub" }));
    expect(bySub.status).toBe(200);
    expect(await signedIn(second)).toBe(false);
    expect(await signedIn(local)).toBe(true);
    // A user the Gateway does not know: accepted, nothing happens.
    expect((await logout(await w.idp.logoutToken({ sub: "stranger" }))).status).toBe(200);
  });

  it("removes a step-up grant without ending the session it was added to", async () => {
    const { w, ctx, olive, logout } = await setup();
    const tenantB = ctx.auth.users.createTenant({ name: "Tenant B" });
    ctx.auth.users.addMembership(tenantB.id, olive.id, "member");
    ctx.oidc.store.linkTenant(tenantB.id, w.providerId);
    ctx.auth.users.setTenantPolicy(tenantB.id, "sso_required");
    const jar = new BrowserJar(w.h.baseUrl);
    expect((await jar.signIn("olive")).status).toBe(200);
    const started = await jar.json<{ authorizationUrl: string }>("POST", "/auth/oidc/corp/start", {
      body: { purpose: "tenant_grant", tenantId: tenantB.id },
    });
    await callback(
      jar,
      w.idp.authorize(started.json.authorizationUrl, { sub: "olive-sub", sid: "idp-step-up" }),
    );
    const inB = () =>
      jar.fetch("GET", "/api/workspaces", { headers: { [TENANT_HEADER]: tenantB.id } });
    expect((await inB()).status).toBe(200);
    expect((await logout(await w.idp.logoutToken({ sid: "idp-step-up" }))).status).toBe(200);
    expect((await inB()).status).toBe(401);
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(200);
  });

  it.each<[string, Parameters<FakeIdp["logoutToken"]>[0]]>([
    ["a key outside the JWKS", { sub: "olive-sub", tamper: { rogueKey: true } }],
    ["another issuer", { sub: "olive-sub", tamper: { iss: "https://evil.example/idp" } }],
    ["another audience", { sub: "olive-sub", tamper: { aud: "someone-else" } }],
    ["an old token", { sub: "olive-sub", tamper: { iatOffset: -900 } }],
    ["no logout event", { sub: "olive-sub", tamper: { noEvent: true } }],
    ["a nonce", { sub: "olive-sub", tamper: { nonce: "n" } }],
    ["neither sub nor sid", {}],
    ["the wrong token type", { sub: "olive-sub", tamper: { typ: "JWT+id" } }],
  ])("refuses a logout token with %s, ending nothing", async (_label, input) => {
    const { viaIdp, logout, signedIn, w } = await setup();
    const jar = await viaIdp("idp-session-1");
    const refused = await logout(await w.idp.logoutToken(input));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_request" });
    expect(await signedIn(jar)).toBe(true);
  });

  it("refuses a replayed token, garbage and an unknown provider", async () => {
    const { w, viaIdp, logout, signedIn } = await setup();
    const token = await w.idp.logoutToken({ sid: "nobody", jti: "fixed-jti" });
    expect((await logout(token)).status).toBe(200);
    const jar = await viaIdp("idp-session-9");
    const replay = await w.idp.logoutToken({ sid: "idp-session-9", jti: "fixed-jti" });
    expect((await logout(replay)).status).toBe(400);
    expect(await signedIn(jar)).toBe(true);
    expect((await logout("not.a.jwt")).status).toBe(400);
    expect((await logout(token, "nope")).status).toBe(404);
  });
});
