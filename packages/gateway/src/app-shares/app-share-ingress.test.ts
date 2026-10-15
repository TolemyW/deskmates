// T1: the app listener (ADR-0035 decisions 2 to 6 and 8). A real HTTP app with a WebSocket and
// an SSE stream sits behind the T1 fake relay; requests carry the `Host` a browser would send.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AppShareOpenResponse } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { FAKE_RELAY_KEY, appRequest, startFakeAppRelay } from "../test-support/fake-app-relay.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { type RoleFixture, seedRoles } from "../test-support/roles.js";
import { createAppIngress } from "./app-share-ingress.js";
import { appSharesOf } from "./app-share-module.js";
import type { AppShareRow } from "./app-share-store.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

interface Seen {
  method: string;
  url: string;
  cookie: string | undefined;
}

/** The workspace's app: a page, an echo API that sets cookies, an SSE stream and a WebSocket. */
async function startApp(seen: Seen[]) {
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", cookie: req.headers.cookie });
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      return; // stays open
    }
    if (req.url?.startsWith("/api/")) {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": [
            "theme=dark; Path=/; Domain=apps.localhost",
            "deskmates-app=planted; Path=/",
            "__Host-deskmates-session=planted; Path=/; Secure",
          ],
        });
        res.end(JSON.stringify({ echo: body }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<p>route ${req.url}</p>`);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (data) => socket.send(`echo:${data}`)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

interface World {
  h: Harness;
  r: RoleFixture;
  port: number;
  share: AppShareRow;
  host: string;
  origin: string;
  /** The operator UI's public origin, the only one an entry ticket is accepted from. */
  operator: string;
  seen: Seen[];
}

/**
 * `baseUrl` and `operatorOrigin` default to a local `apps.localhost` deployment; the TLS reverse
 * proxy topology (decision 11) passes its public URLs while the listener stays plain HTTP.
 */
async function world(topology: { baseUrl?: string; operatorOrigin?: string } = {}): Promise<World> {
  const h = await startHarness();
  cleanup.push(() => h.close());
  const baseUrl = topology.baseUrl ?? "http://apps.localhost";
  const operator = topology.operatorOrigin ?? h.baseUrl;
  Object.assign(h.app.deskmates.ctx.config, {
    appShares: { baseUrl, operatorOrigin: operator, port: 0, bind: "127.0.0.1" },
  });
  const r = await seedRoles(h);
  const seen: Seen[] = [];
  const appPort = await startApp(seen);
  const relay = await startFakeAppRelay(new Map([[3000, appPort]]));
  cleanup.push(() => relay.close());
  h.provider.existing.set(r.workspace.id, {
    workspaceId: r.workspace.id,
    providerRef: "fake",
    sidecarAddress: "fake://sidecar",
    appRelayAddress: relay.address,
    appRelayKey: FAKE_RELAY_KEY,
  });
  const ingress = createAppIngress(h.app.deskmates.ctx);
  await new Promise<void>((resolve) => ingress.server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => ingress.close());
  const port = (ingress.server.address() as AddressInfo).port;
  const { share } = appSharesOf(h.app.deskmates.ctx).store.publish({
    workspaceId: r.workspace.id,
    port: 3000,
    label: "Todo",
    by: { kind: "bot", botId: r.bot.id, runId: "run_x" },
  });
  const base = new URL(baseUrl);
  const host = `${share.id.slice(4)}.${base.host}`;
  return { h, r, port, share, host, origin: `${base.protocol}//${host}`, operator, seen };
}

/** The UI's entry: ticket from the operator API, form POST from the operator origin. */
async function enter(w: World, jar = w.r.member, path = "/") {
  const opened = await jar.json<AppShareOpenResponse>(
    "POST",
    `/api/workspaces/${w.r.workspace.id}/app-shares/${w.share.id}/open`,
    { body: { path } },
  );
  if (opened.status !== 200) throw new Error(`open ${opened.status}`);
  const res = await appRequest(w.port, {
    host: w.host,
    method: "POST",
    path: "/__deskmates/enter",
    headers: {
      origin: w.operator,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ticket: opened.json.ticket }).toString(),
  });
  return { res, ticket: opened.json.ticket };
}

const grantCookie = (setCookie: string[] | undefined) =>
  (setCookie ?? []).find((c) => c.startsWith("deskmates-app="))?.split(";")[0] ?? "";

describe("host routing (decision 2)", () => {
  it("serves only known labels under the base host", async () => {
    const w = await world();
    for (const host of ["apps.localhost", "evil.example", "0000.apps.localhost", `${w.host}.evil`])
      expect((await appRequest(w.port, { host })).status, host).toBe(404);
    // The operator API is not on this listener at all.
    const api = await appRequest(w.port, { host: w.host, path: "/api/workspaces" });
    expect(api.status).toBe(401);
    expect(w.seen).toEqual([]);
  });
});

describe("entry and grants (decision 3)", () => {
  it("sends a person without a grant to Deskmates, never to the app", async () => {
    const w = await world();
    const res = await appRequest(w.port, { host: w.host, path: "/todos/7" });
    expect(res.status).toBe(401);
    expect(res.body).toContain(
      `${w.h.baseUrl}/#/apps/${w.share.id}?ws=${w.r.workspace.id}&#38;path=%2Ftodos%2F7`,
    );
    expect(w.seen).toEqual([]);
  });

  it("accepts a ticket once, from the operator origin only, and sets a host-only grant", async () => {
    const w = await world();
    const opened = await w.r.member.json<AppShareOpenResponse>(
      "POST",
      `/api/workspaces/${w.r.workspace.id}/app-shares/${w.share.id}/open`,
      { body: { path: "/todos/7" } },
    );
    const post = (origin: string) =>
      appRequest(w.port, {
        host: w.host,
        method: "POST",
        path: "/__deskmates/enter",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: `ticket=${opened.json.ticket}`,
      });
    expect((await post(w.origin)).status).toBe(403);
    const ok = await post(w.h.baseUrl);
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe("/todos/7");
    const cookie = ok.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^deskmates-app=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax/);
    expect(cookie).not.toMatch(/domain=/i);
    expect((await post(w.h.baseUrl)).status).toBe(403);
  });

  it("refuses a ticket of one publication at another's host", async () => {
    const w = await world();
    const other = appSharesOf(w.h.app.deskmates.ctx).store.publish({
      workspaceId: w.r.workspace.id,
      port: 3001,
      label: "Other",
      by: { kind: "bot", botId: w.r.bot.id, runId: "run_x" },
    }).share;
    const opened = await w.r.member.json<AppShareOpenResponse>(
      "POST",
      `/api/workspaces/${w.r.workspace.id}/app-shares/${w.share.id}/open`,
      { body: {} },
    );
    const res = await appRequest(w.port, {
      host: `${other.id.slice(4)}.apps.localhost`,
      method: "POST",
      path: "/__deskmates/enter",
      headers: { origin: w.h.baseUrl, "content-type": "application/x-www-form-urlencoded" },
      body: `ticket=${opened.json.ticket}`,
    });
    expect(res.status).toBe(403);
  });

  it("stops admitting after sign-out and after losing the workspace role", async () => {
    const w = await world();
    const cookie = grantCookie((await enter(w)).res.headers["set-cookie"]);
    const get = () => appRequest(w.port, { host: w.host, headers: { cookie } });
    expect((await get()).status).toBe(200);
    w.h.app.deskmates.ctx.auth.memberships.change(
      w.r.workspace.id,
      w.r.ids.mel ?? "",
      { role: "guest" },
      "test",
    );
    expect((await get()).status).toBe(401);
    const second = grantCookie((await enter(w, w.r.otherMember)).res.headers["set-cookie"]);
    const asMax = () => appRequest(w.port, { host: w.host, headers: { cookie: second } });
    expect((await asMax()).status).toBe(200);
    await w.r.otherMember.fetch("POST", "/auth/logout", { body: {} });
    expect((await asMax()).status).toBe(401);
  });
});

describe("forwarding (decisions 4 and 5)", () => {
  it("round-trips a page, a client route and an API call without Deskmates cookies", async () => {
    const w = await world();
    const grant = grantCookie((await enter(w)).res.headers["set-cookie"]);
    const cookie = `${grant}; theme=light; __Host-deskmates-session=leak`;
    const page = await appRequest(w.port, { host: w.host, path: "/todos/7", headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toBe("<p>route /todos/7</p>");
    const api = await appRequest(w.port, {
      host: w.host,
      method: "POST",
      path: "/api/todos",
      headers: { cookie, origin: w.origin, "content-type": "application/json" },
      body: '{"title":"milk"}',
    });
    expect(api.status).toBe(200);
    expect(JSON.parse(api.body)).toEqual({ echo: '{"title":"milk"}' });
    expect(w.seen.map((s) => s.cookie)).toEqual(["theme=light", "theme=light"]);
    expect(api.headers["set-cookie"]).toEqual(["theme=dark; Path=/"]);
  });

  it("refuses a cross-origin unsafe request before it reaches the app", async () => {
    const w = await world();
    const cookie = grantCookie((await enter(w)).res.headers["set-cookie"]);
    const res = await appRequest(w.port, {
      host: w.host,
      method: "POST",
      path: "/api/todos",
      headers: { cookie, origin: "http://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(w.seen).toEqual([]);
  });

  it("does not let one publication's grant into another workspace's publication", async () => {
    const w = await world();
    const { ctx } = w.h.app.deskmates;
    const other = ctx.workspaces.create({ name: "Other", sandboxProvider: "docker" });
    const theirs = appSharesOf(ctx).store.publish({
      workspaceId: other.id,
      port: 3000,
      label: "Theirs",
      by: { kind: "bot", botId: w.r.bot.id, runId: "run_x" },
    }).share;
    const cookie = grantCookie((await enter(w)).res.headers["set-cookie"]);
    const res = await appRequest(w.port, {
      host: `${theirs.id.slice(4)}.apps.localhost`,
      headers: { cookie },
    });
    expect(res.status).toBe(401);
    expect(w.seen).toEqual([]);
  });

  it("reports a service that is not running as 502, not as the app", async () => {
    const w = await world();
    const stopped = appSharesOf(w.h.app.deskmates.ctx).store.publish({
      workspaceId: w.r.workspace.id,
      port: 3999,
      label: "Stopped",
      by: { kind: "bot", botId: w.r.bot.id, runId: "run_x" },
    }).share;
    const host = `${stopped.id.slice(4)}.apps.localhost`;
    const opened = await w.r.member.json<AppShareOpenResponse>(
      "POST",
      `/api/workspaces/${w.r.workspace.id}/app-shares/${stopped.id}/open`,
      { body: {} },
    );
    const entered = await appRequest(w.port, {
      host,
      method: "POST",
      path: "/__deskmates/enter",
      headers: { origin: w.h.baseUrl, "content-type": "application/x-www-form-urlencoded" },
      body: `ticket=${opened.json.ticket}`,
    });
    const res = await appRequest(w.port, {
      host,
      headers: { cookie: grantCookie(entered.headers["set-cookie"]) },
    });
    expect(res.status).toBe(502);
    expect(res.body).toContain("not running");
  });
});

describe("streams and revocation (decisions 6 and 8)", () => {
  it("echoes over a WebSocket, streams SSE before the response ends, and revocation closes both", async () => {
    const w = await world();
    const cookie = grantCookie((await enter(w)).res.headers["set-cookie"]);
    const socket = new WebSocket(`ws://127.0.0.1:${w.port}/ws`, {
      headers: { host: w.host, origin: w.origin, cookie },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      socket.once("open", () => socket.send("hi"));
      socket.once("message", (data) => resolve(String(data)));
      socket.once("error", reject);
    });
    expect(reply).toBe("echo:hi");

    const firstEvent = await new Promise<{ text: string; req: http.ClientRequest }>((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port: w.port, path: "/events", headers: { host: w.host, cookie } },
        (res) => res.once("data", (chunk) => resolve({ text: String(chunk), req })),
      );
    });
    expect(firstEvent.text).toBe("data: first\n\n");

    const wsClosed = new Promise((resolve) => socket.once("close", resolve));
    const sseClosed = new Promise((resolve) => firstEvent.req.once("close", resolve));
    await w.r.admin.fetch("DELETE", `/api/workspaces/${w.r.workspace.id}/app-shares/${w.share.id}`);
    await Promise.all([wsClosed, sseClosed]);
    expect((await appRequest(w.port, { host: w.host, headers: { cookie } })).status).toBe(404);
  });

  it("refuses a cross-origin WebSocket", async () => {
    const w = await world();
    const cookie = grantCookie((await enter(w)).res.headers["set-cookie"]);
    const socket = new WebSocket(`ws://127.0.0.1:${w.port}/ws`, {
      headers: { host: w.host, origin: "http://evil.example", cookie },
    });
    const status = await new Promise<number>((resolve) => {
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("open", () => resolve(101));
    });
    expect(status).toBe(403);
  });
});

describe("an IP-literal operator and a nip.io base behind a TLS proxy (decision 11)", () => {
  it("matches the Host with the public port, sets a __Host- Secure grant and checks Origin", async () => {
    const w = await world({
      baseUrl: "https://10.20.40.132.nip.io:18443",
      operatorOrigin: "https://10.20.40.132:18443",
    });
    expect(w.host).toMatch(/^[0-9a-f]{32}\.10\.20\.40\.132\.nip\.io:18443$/);
    // Caddy keeps the Host; a request for the base host without its port names nothing.
    expect((await appRequest(w.port, { host: w.host.replace(":18443", "") })).status).toBe(404);
    const { res } = await enter(w, w.r.member, "/board");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/board");
    const set = res.headers["set-cookie"]?.[0] ?? "";
    expect(set).toMatch(/^__Host-deskmates-app=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; /);
    expect(set).toMatch(/; Secure$/);
    expect(set).not.toMatch(/domain=/i);
    const cookie = set.split(";")[0] ?? "";
    const page = await appRequest(w.port, { host: w.host, path: "/board", headers: { cookie } });
    expect(page.status).toBe(200);
    const post = (origin: string) =>
      appRequest(w.port, {
        host: w.host,
        method: "POST",
        path: "/api/notes",
        headers: { cookie, origin, "content-type": "application/json" },
        body: "{}",
      });
    expect((await post(w.origin)).status).toBe(200);
    expect(w.origin).toBe(`https://${w.host}`);
    expect((await post(w.origin.replace("https:", "http:"))).status).toBe(403);
    // The entry is accepted only from the operator's exact origin, port included.
    const opened = await w.r.member.json<AppShareOpenResponse>(
      "POST",
      `/api/workspaces/${w.r.workspace.id}/app-shares/${w.share.id}/open`,
      { body: {} },
    );
    expect(opened.json.enterUrl).toBe(`https://${w.host}/__deskmates/enter`);
    const wrongPort = await appRequest(w.port, {
      host: w.host,
      method: "POST",
      path: "/__deskmates/enter",
      headers: {
        origin: "https://10.20.40.132",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `ticket=${opened.json.ticket}`,
    });
    expect(wrongPort.status).toBe(403);
  });
});
