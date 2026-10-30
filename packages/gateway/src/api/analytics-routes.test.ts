// T1, ADR-0046 amendment 1 decisions 13 to 15: the analytics relay. A fake upstream HTTP server
// stands in for Grafana and records what reaches it. Only the root's own browser session passes;
// no session is 401, another person 403, the operator credential and a service principal 403, a
// run token 401. What arrives upstream carries `X-WEBAUTH-USER: admin` and nothing the browser
// asserted about identity, credentials or its address. Bodies stream both ways; a Location on
// Grafana's own origin becomes its path; an unreachable or silent upstream is a 502 that names no
// address; a body past the cap is 413; a WebSocket upgrade is never relayed.

import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  type IncomingHttpHeaders,
  type Server,
  createServer,
  request as httpRequest,
} from "node:http";
import { connect } from "node:net";
import { CSRF_HEADER, TENANT_HEADER } from "@deskmates/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, TEST_OPERATOR_TOKEN, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";
import {
  ANALYTICS_ROUTES,
  downstreamHeaders,
  relayToGrafana,
  rewriteLocation,
  upstreamRequestHeaders,
} from "./analytics-relay.js";
import { registerErrorHandler } from "./errors.js";
import { ORIGIN_CHECKED_ROUTES } from "./operator-auth.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  bytes: number;
  sha256: string;
}

const BIG = 8 * 1024 * 1024;

/** A stand-in Grafana: records every request and answers by path. */
async function fakeGrafana(): Promise<{ server: Server; origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let origin = "";
  const server = createServer((req, res) => {
    const hash = createHash("sha256");
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    req.on("end", () => {
      const sha256 = hash.digest("hex");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        bytes,
        sha256,
      });
      const path = (req.url ?? "").split("?")[0];
      if (path === "/analytics/hang") return; // never answers
      if (path === "/analytics/redirect") {
        res.writeHead(302, { location: `${origin}/analytics/d/run?var-run=r1` }).end();
        return;
      }
      if (path === "/analytics/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 7);
        let sent = 0;
        const pump = () => {
          while (sent < BIG) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        pump();
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "grafana_pref=dark; Path=/analytics/",
          connection: "keep-alive, x-hop",
          "x-hop": "dropped",
        })
        .end(JSON.stringify({ bytes, sha256 }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, seen };
}

let h: Harness | undefined;
const servers: Server[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const close of closers.splice(0)) await close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function relayed() {
  const grafana = await fakeGrafana();
  servers.push(grafana.server);
  h = await startHarness({ auth: FAST_AUTH, observabilityGrafanaUrl: grafana.origin });
  const people = await seedRoles(h);
  return { grafana, people, h };
}

describe("analytics relay admission (amendment 1 decision 13)", () => {
  it("refuses without a session, refuses another person, forwards the root", async () => {
    const { grafana, people, h } = await relayed();
    const anonymous = await fetch(`${h.baseUrl}/analytics/`);
    expect(anonymous.status).toBe(401);
    const owner = await people.owner.json<{ details?: { reason?: string } }>("GET", "/analytics/");
    expect(owner.status).toBe(403);
    expect(owner.json.details?.reason).toBe("root_only");
    expect(grafana.seen).toHaveLength(0);

    const root = await people.root.fetch("GET", "/analytics/api/search?query=runs&tag=deskmates");
    expect(root.status).toBe(200);
    expect(grafana.seen).toHaveLength(1);
    expect(grafana.seen[0]).toMatchObject({
      method: "GET",
      url: "/analytics/api/search?query=runs&tag=deskmates",
    });
    expect(grafana.seen[0]?.headers["x-webauth-user"]).toBe("admin");
    expect(grafana.seen[0]?.headers.host).toBe(new URL(grafana.origin).host);
    // `/analytics` itself is relayed too; Grafana redirects it to the sub path.
    expect((await people.root.fetch("GET", "/analytics")).status).toBe(200);
    expect(grafana.seen[1]?.url).toBe("/analytics");
  });

  it("never passes a bearer credential: run token 401, operator credential and service principal 403", async () => {
    const { grafana, people, h } = await relayed();
    const ctx = h.app.deskmates.ctx;
    const run = ctx.runs.create({
      botId: people.bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "analytics-test",
      triggerPayload: { body: "x" },
      config: ctx.runConfig(),
    });
    const bearer = (token: string) =>
      fetch(`${h.baseUrl}/analytics/api/search`, { headers: { authorization: `Bearer ${token}` } });
    expect((await bearer(ctx.tokens.issue(run.id).token)).status).toBe(401);
    expect((await bearer(TEST_OPERATOR_TOKEN)).status).toBe(403);
    const created = await h.api<{ token: string }>("POST", "/api/service-principals", {
      name: "analytics-reader",
    });
    expect(created.status).toBe(201);
    expect((await bearer(created.json.token)).status).toBe(403);
    // A session with a bearer beside it is judged by the bearer.
    const both = await people.root.fetch("GET", "/analytics/api/search", {
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    });
    expect(both.status).toBe(403);
    expect(grafana.seen).toHaveLength(0);
  });

  it("checks Origin on unsafe methods but not the CSRF header Grafana cannot send", async () => {
    const { grafana, people } = await relayed();
    const body = { queries: [{ refId: "A" }] };
    const forged = await people.root.fetch("POST", "/analytics/api/ds/query", {
      body,
      csrf: null,
      origin: "https://evil.example.test",
    });
    expect(forged.status).toBe(403);
    expect(
      (await people.root.fetch("POST", "/analytics/api/ds/query", { body, origin: null })).status,
    ).toBe(403);
    expect(grafana.seen).toHaveLength(0);
    const sameOrigin = await people.root.fetch("POST", "/analytics/api/ds/query", {
      body,
      csrf: null,
    });
    expect(sameOrigin.status).toBe(200);
    expect(grafana.seen[0]?.method).toBe("POST");
    // The exemption is the relay's two patterns and nothing else.
    expect([...ORIGIN_CHECKED_ROUTES].sort()).toEqual([...ANALYTICS_ROUTES].sort());
    // Every other route still needs the CSRF header.
    expect((await people.root.fetch("POST", "/auth/logout-all", { csrf: null })).status).toBe(403);
  });

  it("is 404 for the root when no Grafana is configured", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const people = await seedRoles(h);
    expect((await people.root.fetch("GET", "/analytics/")).status).toBe(404);
    expect((await people.root.fetch("GET", "/analytics")).status).toBe(404);
  });
});

describe("analytics relay forwarding (amendment 1 decision 14)", () => {
  it("strips every client identity, credential and forwarding header and the Gateway's cookies", async () => {
    const { grafana, people } = await relayed();
    const sessionCookies = [...people.root.cookies.keys()];
    expect(sessionCookies.length).toBeGreaterThan(0);
    expect(sessionCookies.every((name) => name.includes("deskmates"))).toBe(true);
    // A cookie Grafana set earlier rides along with the Gateway's own.
    people.root.cookies.set("grafana_pref", "light");
    const res = await people.root.fetch("POST", "/analytics/api/user/preferences", {
      body: { theme: "dark" },
      headers: {
        "x-webauth-user": "oona",
        "X-WEBAUTH-EMAIL": "oona@example.test",
        "x-webauth-role": "Admin",
        "x-forwarded-for": "10.9.8.7",
        "x-forwarded-host": "evil.example.test",
        "x-real-ip": "10.9.8.7",
        forwarded: "for=10.9.8.7",
        "x-grafana-org-id": "1",
      },
    });
    expect(res.status).toBe(200);
    const seen = grafana.seen[0];
    expect(seen?.headers["x-webauth-user"]).toBe("admin");
    const names = Object.keys(seen?.headers ?? {});
    expect(names.filter((n) => n.startsWith("x-webauth-"))).toEqual(["x-webauth-user"]);
    expect(names.filter((n) => n.startsWith("x-forwarded-"))).toEqual([]);
    for (const name of ["authorization", "origin", "forwarded", "x-real-ip", CSRF_HEADER])
      expect(names, name).not.toContain(name);
    expect(seen?.headers.cookie).toBe("grafana_pref=light");
    for (const name of sessionCookies) expect(seen?.headers.cookie).not.toContain(name);
    expect(seen?.headers["x-grafana-org-id"]).toBe("1");
    // Grafana's own cookies come back; hop-by-hop headers, and those its Connection names, stop.
    expect(res.headers.getSetCookie()).toEqual(["grafana_pref=dark; Path=/analytics/"]);
    expect(res.headers.get("x-hop")).toBeNull();
  });

  it("streams a large body each way unchanged", async () => {
    const { grafana, people } = await relayed();
    const upload = randomBytes(6 * 1024 * 1024);
    const sent = await people.root.fetch("POST", "/analytics/api/upload", {
      raw: { bytes: upload, contentType: "application/octet-stream" },
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({
      bytes: upload.length,
      sha256: createHash("sha256").update(upload).digest("hex"),
    });
    expect(grafana.seen[0]?.headers["content-length"]).toBe(String(upload.length));

    const big = await people.root.fetch("GET", "/analytics/big");
    expect(big.status).toBe(200);
    expect(big.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = Buffer.from(await big.arrayBuffer());
    expect(bytes.length).toBe(BIG);
    expect(bytes.every((b) => b === 7)).toBe(true);
  });

  it("rewrites a Location on Grafana's own origin to its path", async () => {
    const { people } = await relayed();
    const res = await people.root.fetch("GET", "/analytics/redirect", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/analytics/d/run?var-run=r1");
  });

  it("answers 502 without the upstream address when Grafana is down", async () => {
    const grafana = await fakeGrafana();
    const { origin } = grafana;
    await new Promise((resolve) => grafana.server.close(resolve));
    h = await startHarness({ auth: FAST_AUTH, observabilityGrafanaUrl: origin });
    const people = await seedRoles(h);
    const res = await people.root.fetch("GET", "/analytics/");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      code: "analytics_unavailable",
      details: { reason: "unreachable" },
    });
    expect(text).not.toContain(new URL(origin).port);
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toMatch(/ECONNREFUSED/);
  });

  it("does not relay a WebSocket upgrade (decision 15)", async () => {
    const { grafana, people, h } = await relayed();
    const { port } = new URL(h.baseUrl);
    const socket = connect(Number(port), "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      [
        "GET /analytics/api/live/ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        `Cookie: ${people.root.cookieHeader()}`,
        "",
        "",
      ].join("\r\n"),
    );
    let answer = "";
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString("latin1");
    });
    await once(socket, "close");
    expect(answer).not.toMatch(/^HTTP\/1\.1 101/);
    expect(grafana.seen).toHaveLength(0);
  });
});

describe("analytics relay bounds", () => {
  async function bounded() {
    const grafana = await fakeGrafana();
    servers.push(grafana.server);
    const app = Fastify();
    registerErrorHandler(app);
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    const upstream = new URL(grafana.origin);
    app.route({
      method: ["GET", "POST"],
      url: "/analytics/*",
      handler: (request, reply) =>
        relayToGrafana(request, reply, upstream, { headersMs: 200, idleMs: 200, bodyBytes: 1024 }),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const address = app.server.address();
    if (!address || typeof address !== "object") throw new Error("no address");
    return { grafana, base: `http://127.0.0.1:${address.port}` };
  }

  it("gives up on an upstream that never answers, with a 502", async () => {
    const { base } = await bounded();
    const started = Date.now();
    const res = await fetch(`${base}/analytics/hang`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ details: { reason: "timeout" } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a body past the cap, declared or streamed", async () => {
    const { base, grafana } = await bounded();
    const declared = await fetch(`${base}/analytics/api/x`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(4096),
    });
    expect(declared.status).toBe(413);
    expect(grafana.seen).toHaveLength(0);
    // Chunked, so no length is declared: the relay counts what passes.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/analytics/api/x`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.write(Buffer.alloc(800));
      req.end(Buffer.alloc(800));
    });
    expect(status).toBe(413);
  });
});

describe("analytics relay headers", () => {
  const upstream = new URL("http://127.0.0.1:18700");

  it("drops hop-by-hop headers and those Connection names, and sets one identity", () => {
    const out = upstreamRequestHeaders(
      {
        host: "deskmates.example.test",
        connection: "keep-alive, x-secret",
        "x-secret": "1",
        te: "trailers",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        "proxy-authorization": "Basic x",
        "x-webauth-user": "someone",
        [CSRF_HEADER]: "csrf",
        [TENANT_HEADER]: "tenant-x",
        cookie: "deskmates-dev-session=s; __Host-deskmates-session=t; __Host-deskmates-login=l",
        accept: "application/json",
      },
      upstream.host,
    );
    expect(out).toEqual({
      accept: "application/json",
      host: "127.0.0.1:18700",
      "x-webauth-user": "admin",
    });
    expect(
      downstreamHeaders(
        { connection: "close, x-a", "x-a": "1", "keep-alive": "timeout=5", "x-b": "2" },
        upstream,
      ),
    ).toEqual({ "x-b": "2" });
  });

  it("rewrites only a Location that points at Grafana itself", () => {
    expect(rewriteLocation("http://127.0.0.1:18700/analytics/login?x=1#f", upstream)).toBe(
      "/analytics/login?x=1#f",
    );
    // Grafana's root_url names 127.0.0.1 even when the Gateway dials another loopback name.
    expect(rewriteLocation("http://localhost:18700/analytics/", upstream)).toBe("/analytics/");
    expect(rewriteLocation("//127.0.0.1:18700/analytics/", upstream)).toBe("/analytics/");
    expect(rewriteLocation("/analytics/d/x", upstream)).toBe("/analytics/d/x");
    expect(rewriteLocation("d/x", upstream)).toBe("d/x");
    expect(rewriteLocation("http://127.0.0.1:9999/analytics/", upstream)).toBe(
      "http://127.0.0.1:9999/analytics/",
    );
    expect(rewriteLocation("https://idp.example.test/authorize", upstream)).toBe(
      "https://idp.example.test/authorize",
    );
  });
});
