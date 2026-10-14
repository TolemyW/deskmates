// T1: ADR-0022 P1 browser sign-in over real HTTP (test plan AUTH-01..04, TASK-01, REG-01).
// Every negative case is paired with a same-scope success so a broken endpoint cannot pass as a
// refusal, and every refusal is checked for side effects (no cookie set, session still valid).

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticatedSessionView, ScreenAccess, Task } from "@deskmates/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { buildGateway } from "../index.js";
import {
  BrowserJar,
  FAST_AUTH,
  TEST_PASSWORD,
  parseSetCookies,
} from "../test-support/browser-session.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { startFakeVnc } from "../test-support/fake-vnc.js";
import { type Harness, startHarness, testConfig, waitFor } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { OPERATOR_ROUTE_RULES } from "./permission-matrix.js";
import { registerOperatorRoutes } from "./routes.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function harness(overrides: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness({ auth: FAST_AUTH, ...overrides });
  cleanups.push(() => h.close());
  return h;
}

async function withOwner(h: Harness, loginName = "owner@example.com", root = true) {
  return createOwner(
    h.app.deskmates.ctx.auth,
    { loginName, displayName: "Olive Owner", password: TEST_PASSWORD },
    { root },
  );
}

async function signedIn(h: Harness, loginName = "owner@example.com"): Promise<BrowserJar> {
  const jar = new BrowserJar(h.baseUrl);
  const response = await jar.signIn(loginName);
  expect(response.status).toBe(200);
  return jar;
}

/** Follow an SSE response until the server ends it; resolves with the time it ended. */
function streamEnd(response: Response): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  return (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // A destroyed socket ends the stream with an error; that is an end too.
    }
    return Date.now();
  })();
}

const SESSION = "__Host-deskmates-session";
const LOGIN = "__Host-deskmates-login";

describe("AUTH-01: bootstrap, closed signup and login", () => {
  it("an unconfigured Gateway stays locked: no route creates an account", async () => {
    const h = await harness();
    const jar = new BrowserJar(h.baseUrl);
    const anonymous = await jar.json<{
      authenticated: boolean;
      setupRequired: boolean;
      loginCsrf: string;
    }>("GET", "/auth/session");
    expect(anonymous.status).toBe(200);
    expect(anonymous.json).toMatchObject({ authenticated: false, setupRequired: true });
    expect(anonymous.response.headers.get("cache-control")).toBe("no-store");
    for (const path of ["/auth/signup", "/auth/register", "/auth/bootstrap", "/api/users"]) {
      const response = await jar.fetch("POST", path, {
        body: { loginName: "first", password: TEST_PASSWORD, displayName: "First" },
        csrf: anonymous.json.loginCsrf,
      });
      expect([401, 404], path).toContain(response.status);
    }
    expect((await jar.signIn("first")).status).toBe(401);
    expect(h.app.deskmates.ctx.auth.setupRequired()).toBe(true);
    // The protected root account is created once, on an empty database (ADR-0031 decision 8);
    // a second one is refused and the first must change its default password.
    expect(await h.app.deskmates.ctx.auth.ensureProtectedRoot()).toBeDefined();
    expect(await h.app.deskmates.ctx.auth.ensureProtectedRoot()).toBeUndefined();
    await expect(withOwner(h, "second")).rejects.toThrow(/UNIQUE/);
    expect(h.app.deskmates.ctx.auth.users.userCount()).toBe(1);
    const root = new BrowserJar(h.baseUrl);
    const opened = await root.signIn("admin", "admin");
    expect(opened.status).toBe(200);
    const session = await root.json<{ passwordChangeRequired?: boolean }>("GET", "/auth/session");
    expect(session.json.passwordChangeRequired).toBe(true);
    const refused = await root.json<{ details?: { reason?: string } }>("GET", "/api/workspaces");
    expect(refused.status).toBe(403);
    expect(refused.json.details?.reason).toBe("password_change_required");
  });

  it("sets a __Host- Secure HttpOnly SameSite=Lax session cookie and restores the session", async () => {
    const h = await harness();
    const owner = await withOwner(h);
    const jar = new BrowserJar(h.baseUrl);
    const login = await jar.signIn("OWNER@example.com");
    expect(login.status).toBe(200);
    expect(login.headers.get("cache-control")).toBe("no-store");
    const cookies = parseSetCookies(login);
    const session = cookies.find((c) => c.name === SESSION);
    expect(session?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session?.attributes).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure", "Max-Age=2592000"]),
    );
    expect(session?.attributes.some((a) => a.toLowerCase().startsWith("domain"))).toBe(false);
    expect(cookies.find((c) => c.name === LOGIN)?.attributes).toContain("Max-Age=0");
    const body = (await login.json()) as AuthenticatedSessionView;
    expect(JSON.stringify(body)).not.toContain(session?.value ?? "missing");
    expect(body).toMatchObject({
      authenticated: true,
      user: { id: owner.id, displayName: "Olive Owner", loginName: "owner@example.com" },
      tenant: { id: DEFAULT_TENANT_ID, role: "owner" },
    });
    // A reload asks the Gateway, which recognises the cookie.
    const restored = await jar.json<AuthenticatedSessionView>("GET", "/auth/session");
    expect(restored.json).toMatchObject({ authenticated: true, csrfToken: body.csrfToken });
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(200);
  });

  it("answers unknown names and wrong passwords identically, then throttles", async () => {
    const h = await harness();
    await withOwner(h);
    const unknown = await new BrowserJar(h.baseUrl).signIn("nobody", TEST_PASSWORD);
    const wrong = await new BrowserJar(h.baseUrl).signIn("owner@example.com", "wrong password!!!");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.text()).toBe(await wrong.text());
    for (let i = 0; i < 4; i++)
      expect(
        (await new BrowserJar(h.baseUrl).signIn("owner@example.com", "nope nope nope")).status,
      ).toBe(401);
    // Five failures for this name: even the right password is refused for the window.
    const limited = await new BrowserJar(h.baseUrl).signIn("owner@example.com");
    expect(limited.status).toBe(429);
    expect(parseSetCookies(limited).some((c) => c.name === SESSION)).toBe(false);
  });

  it("restores a session across a Gateway restart and forgets it after logout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-auth-restart-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "gateway.sqlite");
    const first = await startHarness({ auth: FAST_AUTH, dbPath });
    await withOwner(first);
    const jar = await signedIn(first);
    await first.close();

    const second = await startHarness({ auth: FAST_AUTH, dbPath });
    cleanups.push(() => second.close());
    const moved = new BrowserJar(second.baseUrl);
    for (const [name, value] of jar.cookies) moved.cookies.set(name, value);
    moved.csrf = jar.csrf;
    expect(
      (await moved.json<{ authenticated: boolean }>("GET", "/auth/session")).json.authenticated,
    ).toBe(true);
    expect((await moved.fetch("GET", "/api/workspaces")).status).toBe(200);
    expect((await moved.fetch("POST", "/auth/logout")).status).toBe(200);
    const stale = new BrowserJar(second.baseUrl);
    stale.cookies.set(SESSION, jar.cookies.get(SESSION) ?? "");
    expect((await stale.fetch("GET", "/api/workspaces")).status).toBe(401);
  });

  it("never adopts a session value the client chose before signing in", async () => {
    const h = await harness();
    await withOwner(h);
    const jar = new BrowserJar(h.baseUrl);
    jar.cookies.set(SESSION, "attacker-planted-session-value-aaaaaaaaaaaaaaaa");
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(401);
    expect((await jar.signIn("owner@example.com")).status).toBe(200);
    expect(jar.cookies.get(SESSION)).not.toBe("attacker-planted-session-value-aaaaaaaaaaaaaaaa");
    expect(jar.cookies.get(SESSION)).not.toBe(jar.cookies.get(LOGIN));
  });
});

describe("listener separation (ADR-0006 decision 2)", () => {
  it("serves /auth/* on the operator listener only", async () => {
    const sandbox = buildGateway(testConfig({ auth: FAST_AUTH }), new FakeProvider(), {
      startCron: false,
    });
    cleanups.push(() => sandbox.close());
    await sandbox.ready();
    for (const [method, url] of [
      ["GET", "/auth/session"],
      ["POST", "/auth/login"],
      ["POST", "/auth/logout"],
    ] as const)
      expect((await sandbox.inject({ method, url, payload: {} })).statusCode, url).toBe(404);
  });
});

describe("AUTH-03: CSRF and Origin", () => {
  it("requires the pre-login token and a same-origin Origin to sign in", async () => {
    const h = await harness();
    await withOwner(h);
    const jar = new BrowserJar(h.baseUrl);
    const anonymous = await jar.json<{ loginCsrf: string }>("GET", "/auth/session");
    const other = new BrowserJar(h.baseUrl);
    const otherToken = (await other.json<{ loginCsrf: string }>("GET", "/auth/session")).json
      .loginCsrf;
    const body = { loginName: "owner@example.com", password: TEST_PASSWORD };
    const cases: Array<[string, Parameters<BrowserJar["fetch"]>[2]]> = [
      ["no token", { body, csrf: null }],
      ["another browser's token", { body, csrf: otherToken }],
      ["hostile origin", { body, csrf: anonymous.json.loginCsrf, origin: "https://evil.example" }],
      ["no origin", { body, csrf: anonymous.json.loginCsrf, origin: null }],
    ];
    for (const [name, options] of cases) {
      const response = await jar.fetch("POST", "/auth/login", options);
      expect(response.status, name).toBe(403);
      expect(
        parseSetCookies(response).some((c) => c.name === SESSION),
        name,
      ).toBe(false);
    }
    const ok = await jar.fetch("POST", "/auth/login", { body, csrf: anonymous.json.loginCsrf });
    expect(ok.status).toBe(200);
  });

  it("refuses cookie mutations without the session CSRF token or from another origin", async () => {
    const h = await harness();
    await withOwner(h);
    const jar = await signedIn(h);
    const create = (options: Parameters<BrowserJar["fetch"]>[2]) =>
      jar.fetch("POST", "/api/workspaces", { body: { name: "csrf-ws" }, ...options });
    expect((await create({ csrf: null })).status).toBe(403);
    expect((await create({ csrf: "forged" })).status).toBe(403);
    expect((await create({ origin: "https://evil.example" })).status).toBe(403);
    expect((await create({ origin: null })).status).toBe(403);
    expect((await create({ origin: "null" })).status).toBe(403);
    expect(h.app.deskmates.ctx.workspaces.list()).toHaveLength(0);
    const ok = await create({});
    expect(ok.status).toBe(201);
    expect(h.app.deskmates.ctx.workspaces.list()).toHaveLength(1);
    // A safe method needs no CSRF token; credentialed CORS is never granted.
    const read = await jar.fetch("GET", "/api/workspaces", {
      headers: { origin: "https://evil.example" },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    expect(read.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("logout and logout-all are CSRF-protected too", async () => {
    const h = await harness();
    await withOwner(h);
    const jar = await signedIn(h);
    for (const path of ["/auth/logout", "/auth/logout-all", "/auth/password"]) {
      expect((await jar.fetch("POST", path, { csrf: null })).status, path).toBe(403);
      expect((await jar.fetch("POST", path, { origin: "https://evil.example" })).status, path).toBe(
        403,
      );
    }
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(200);
  });

  it("honours a configured origin list instead of the Host header", async () => {
    const h = await harness({
      auth: { ...FAST_AUTH, allowedOrigins: ["https://deskmates.example"] },
    });
    await withOwner(h);
    const jar = new BrowserJar(h.baseUrl, "https://deskmates.example");
    expect((await jar.signIn("owner@example.com")).status).toBe(200);
    expect((await jar.fetch("POST", "/api/workspaces", { body: { name: "listed" } })).status).toBe(
      201,
    );
    expect(
      (
        await jar.fetch("POST", "/api/workspaces", {
          body: { name: "same-host" },
          origin: h.baseUrl,
        })
      ).status,
    ).toBe(403);
  });

  it("every registered unsafe /api route refuses a session cookie without CSRF", async () => {
    const sandbox = buildGateway(testConfig({ auth: FAST_AUTH }), new FakeProvider(), {
      startCron: false,
    });
    cleanups.push(() => sandbox.close());
    await sandbox.ready();
    const ctx = sandbox.deskmates.ctx;
    await createOwner(ctx.auth, {
      loginName: "owner",
      displayName: "O",
      password: TEST_PASSWORD,
    });
    const { token } = await ctx.auth.login("owner", TEST_PASSWORD, "127.0.0.1");
    const routeApp = Fastify();
    const routes: Array<{ method: string; url: string }> = [];
    routeApp.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods)
        if (
          route.url.startsWith("/api/") &&
          !["GET", "HEAD", "OPTIONS"].includes(method) &&
          !(`${method} ${route.url}` in OPERATOR_ROUTE_RULES)
        )
          routes.push({ method, url: route.url });
    });
    registerOperatorRoutes(routeApp, ctx, sandbox.deskmates.scheduler);
    await routeApp.ready();
    cleanups.push(() => routeApp.close());
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      const url = route.url.replace(/:([A-Za-z0-9_]+)/g, "missing-$1").replace(/\*/g, "missing");
      const response = await routeApp.inject({
        method: route.method as "POST",
        url,
        headers: { cookie: `${SESSION}=${token}`, host: "gw.test", origin: "http://gw.test" },
        payload: {},
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json().details.reason, `${route.method} ${route.url}`).toBe("csrf");
    }
  });
});

describe("AUTH-04: revocation reaches requests and live connections", () => {
  it("logout ends the session and its SSE stream at once; other sessions continue", async () => {
    const h = await harness();
    await withOwner(h);
    const a = await signedIn(h);
    const b = await signedIn(h);
    const stream = await a.fetch("GET", "/api/events", {
      headers: { accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const ended = streamEnd(stream);
    await waitFor(() => h.app.deskmates.ctx.auth.live.count() === 1, 1000, "stream registered");
    const before = Date.now();
    expect((await a.fetch("POST", "/auth/logout")).status).toBe(200);
    const latency = (await ended) - before;
    expect(latency).toBeLessThan(500);
    expect(a.cookies.has(SESSION)).toBe(false);
    const replay = new BrowserJar(h.baseUrl);
    replay.cookies.set(SESSION, "x");
    expect((await a.fetch("GET", "/api/workspaces")).status).toBe(401);
    expect((await b.fetch("GET", "/api/workspaces")).status).toBe(200);
  });

  it("logout-all closes every session and stream of the user", async () => {
    const h = await harness();
    await withOwner(h);
    const a = await signedIn(h);
    const b = await signedIn(h);
    const ended = streamEnd(await b.fetch("GET", "/api/events"));
    await waitFor(() => h.app.deskmates.ctx.auth.live.count() === 1, 1000, "stream registered");
    const result = await a.json<{ sessionsRevoked: number }>("POST", "/auth/logout-all");
    expect(result.json.sessionsRevoked).toBe(2);
    await ended;
    expect((await a.fetch("GET", "/api/workspaces")).status).toBe(401);
    expect((await b.fetch("GET", "/api/workspaces")).status).toBe(401);
  });

  it("a password change rotates the session and CSRF token and ends other sessions", async () => {
    const h = await harness();
    await withOwner(h);
    const a = await signedIn(h);
    const b = await signedIn(h);
    const oldCookie = a.cookies.get(SESSION);
    const oldCsrf = a.csrf;
    expect(
      (
        await a.fetch("POST", "/auth/password", {
          body: { currentPassword: "not the password", newPassword: "a brand new password" },
        })
      ).status,
    ).toBe(403);
    const changed = await a.json<AuthenticatedSessionView>("POST", "/auth/password", {
      body: { currentPassword: TEST_PASSWORD, newPassword: "a brand new password" },
    });
    expect(changed.status).toBe(200);
    expect(a.cookies.get(SESSION)).not.toBe(oldCookie);
    expect(changed.json.csrfToken).not.toBe(oldCsrf);
    expect(
      (await a.fetch("POST", "/api/workspaces", { body: { name: "x" }, csrf: oldCsrf })).status,
    ).toBe(403);
    a.csrf = changed.json.csrfToken;
    expect((await a.fetch("POST", "/api/workspaces", { body: { name: "x" } })).status).toBe(201);
    expect((await b.fetch("GET", "/api/workspaces")).status).toBe(401);
  });

  it("a revocation written outside this process closes the stream within one sweep", async () => {
    const h = await harness();
    // Not the protected root, which can never be disabled.
    await withOwner(h, "owner@example.com", false);
    const jar = await signedIn(h);
    const ended = streamEnd(await jar.fetch("GET", "/api/events"));
    await waitFor(() => h.app.deskmates.ctx.auth.live.count() === 1, 1000, "stream registered");
    // What the maintenance CLI does: a direct database write, no in-process notification.
    h.app.deskmates.ctx.db.prepare("UPDATE users SET status = 'disabled'").run();
    const before = Date.now();
    const latency = (await ended) - before;
    expect(latency).toBeLessThan(1000);
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(401);
  });

  it("removing or demoting a member invalidates their session and stream", async () => {
    const h = await harness();
    await withOwner(h);
    // Roles are per workspace (ADR-0031 decision 7): Mo is an Admin of this one.
    const workspace = h.app.deskmates.ctx.workspaces.create({
      name: "W",
      sandboxProvider: "docker",
    });
    const member = await h.app.deskmates.ctx.auth.createUser({
      loginName: "mo",
      displayName: "Mo",
      password: TEST_PASSWORD,
      role: "admin",
      workspaceId: workspace.id,
    });
    const jar = await signedIn(h, "mo");
    const ended = streamEnd(await jar.fetch("GET", "/api/events"));
    await waitFor(() => h.app.deskmates.ctx.auth.live.count() === 1, 1000, "stream registered");
    h.app.deskmates.ctx.auth.users.updateMembership(DEFAULT_TENANT_ID, member.id, {
      role: "member",
      workspaceId: workspace.id,
    });
    await ended;
    expect((await jar.fetch("GET", "/api/workspaces")).status).toBe(401);
    const again = await signedIn(h, "mo");
    expect(
      (await again.json<AuthenticatedSessionView>("GET", "/auth/session")).json.tenant.role,
    ).toBe("member");
  });

  it("refuses the SSE credential in a URL and accepts the header for machine clients", async () => {
    const h = await harness();
    const query = await fetch(
      `${h.baseUrl}/api/events?token=operator-test-token-at-least-32-bytes-long`,
    );
    expect(query.status).toBe(401);
    const controller = new AbortController();
    const header = await fetch(`${h.baseUrl}/api/events`, {
      headers: { authorization: "Bearer operator-test-token-at-least-32-bytes-long" },
      signal: controller.signal,
    });
    expect(header.status).toBe(200);
    controller.abort();
  });

  it("a desktop ticket dies with the session that asked for it, before or after upgrade", async () => {
    const h = await harness();
    await withOwner(h);
    const { workspace, bot } = await h.seed();
    const vnc = await startFakeVnc({ control: "control1", view: "viewonly" });
    cleanups.push(() => vnc.close());
    const address = vnc.address;
    vi.spyOn(h.app.deskmates.ctx.sandboxes, "peek").mockResolvedValue({
      workspaceId: workspace.id,
      providerRef: "test",
      sidecarAddress: "test",
      botScreenAddresses: Array(6).fill(address),
      novncPassword: "control1",
      novncViewPassword: "viewonly",
    });
    h.app.deskmates.ctx.screens.ensure(bot.id, workspace.id);
    const ws = h.baseUrl.replace("http:", "ws:");

    // Ticket issued, then the session signs out: the ticket no longer opens a socket.
    const a = await signedIn(h);
    const pending = await a.json<ScreenAccess>("POST", `/api/bots/${bot.id}/screen/access`, {
      body: { mode: "view" },
    });
    expect(pending.status).toBe(200);
    await a.fetch("POST", "/auth/logout");
    const refused = new WebSocket(`${ws}${pending.json.path}`, [pending.json.protocol], {
      origin: h.baseUrl,
    });
    await once(refused, "error");

    // An open socket closes when its session signs out.
    const b = await signedIn(h);
    const access = await b.json<ScreenAccess>("POST", `/api/bots/${bot.id}/screen/access`, {
      body: { mode: "view" },
    });
    const client = new WebSocket(`${ws}${access.json.path}`, [access.json.protocol], {
      origin: h.baseUrl,
    });
    // The proxy authenticated to the screen and greets the browser as an RFB server.
    expect(String((await once(client, "message"))[0])).toBe("RFB 003.008\n");
    const closed = once(client, "close");
    await b.fetch("POST", "/auth/logout");
    await closed;
  });
});

describe("TASK-01: acceptance is attributed to the authenticated principal", () => {
  it("records user:<id> for a signed-in person and human:web for the shared credential", async () => {
    const h = await harness();
    const owner = await withOwner(h);
    const { workspace } = await h.seed();
    const jar = await signedIn(h);
    const url = `/api/workspaces/${workspace.id}/tasks`;
    const runsBefore = h.app.deskmates.ctx.runs.list({}).length;

    const deliver = async (title: string): Promise<Task> => {
      const created = await jar.json<{ task: Task }>("POST", url, { body: { title } });
      expect(created.status).toBe(201);
      const delivered = await jar.json<{ task: Task }>("PATCH", `${url}/${created.json.task.id}`, {
        body: {
          version: created.json.task.version,
          status: "delivered",
          artifacts: [{ label: "Report", path: "/work/report.md" }],
        },
      });
      expect(delivered.status).toBe(200);
      return delivered.json.task;
    };

    const mine = await deliver("Signed-in acceptance");
    // A client-supplied actor is refused outright, with no state change.
    const forged = await jar.json<{ code: string }>("POST", `${url}/${mine.id}/accept`, {
      body: { version: mine.version, acceptedBy: "human:web" },
    });
    expect(forged.status).toBe(400);
    expect((await jar.json<{ task: Task }>("GET", `${url}/${mine.id}`)).json.task.status).toBe(
      "delivered",
    );
    const accepted = await jar.json<{ task: Task }>("POST", `${url}/${mine.id}/accept`, {
      body: { version: mine.version },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json.task).toMatchObject({
      status: "accepted",
      acceptedBy: `user:${owner.id}`,
    });

    const shared = await deliver("Shared-credential acceptance");
    const bearer = await h.api<{ task: Task }>("POST", `${url}/${shared.id}/accept`, {
      version: shared.version,
    });
    expect(bearer.json.task.acceptedBy).toBe("human:web");

    // Task bookkeeping never starts work.
    expect(h.app.deskmates.ctx.runs.list({})).toHaveLength(runsBefore);
  });
});
