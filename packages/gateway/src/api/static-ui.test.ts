// T1: the built operator UI served from the operator listener (WEB_DIST_DIR). Static files carry
// no secret and need no credential, so the tests that matter are the ones proving the static
// handler opened nothing else: every `/api` route still needs the operator token, the sandbox
// listener serves no UI, and no request path escapes the configured directory.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../config.js";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";
import { registerOperatorRoutes } from "./routes.js";

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
const OUTSIDE_SECRET = "outside-the-dist-dir-must-never-be-served";

let base: string;
let dist: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "deskmates-static-ui-"));
  dist = join(base, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX_HTML);
  writeFileSync(join(dist, "assets", "index-Ab12Cd34.js"), "console.log('ui');");
  writeFileSync(join(dist, "assets", "index-Ab12Cd34.css"), "body{margin:0}");
  mkdirSync(join(dist, "integration-logos"));
  writeFileSync(
    join(dist, "integration-logos", "github.svg"),
    "<svg xmlns='http://www.w3.org/2000/svg'/>",
  );
  writeFileSync(join(dist, "favicon-32x32.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(dist, "apple-touch-icon.png"), Buffer.from([137, 80, 78, 71]));
  mkdirSync(join(dist, "agent-skill"));
  writeFileSync(join(dist, "agent-skill", "SKILL.md"), "# Deskmates\n");
  writeFileSync(join(base, "secret.txt"), OUTSIDE_SECRET);
  symlinkSync(join(base, "secret.txt"), join(dist, "linked-secret.txt"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function stack(overrides: Partial<GatewayConfig> = { webDistDir: dist }) {
  const sandbox = buildGateway(testConfig(overrides), new FakeProvider(), { startCron: false });
  const operator = buildOperatorGateway(sandbox.deskmates);
  apps.push(operator, sandbox);
  await Promise.all([sandbox.ready(), operator.ready()]);
  return { sandbox, operator };
}

/** A raw HTTP request: `inject` and `fetch` normalise `..` and `%2e%2e` before sending. */
async function raw(app: FastifyInstance, path: string): Promise<{ status: number; body: string }> {
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: addr.port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("operator listener static UI", () => {
  it("serves index.html at / without a credential and marks it no-cache", async () => {
    const { operator } = await stack();
    const res = await operator.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toBe(INDEX_HTML);
  });

  it("serves hashed assets with their content type and a long immutable cache", async () => {
    const { operator } = await stack();
    const js = await operator.inject({ method: "GET", url: "/assets/index-Ab12Cd34.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.body).toBe("console.log('ui');");
    const css = await operator.inject({ method: "GET", url: "/assets/index-Ab12Cd34.css" });
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
    const svg = await operator.inject({ method: "GET", url: "/integration-logos/github.svg" });
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["cache-control"]).toBe("no-cache");
    for (const path of ["/favicon-32x32.png", "/apple-touch-icon.png"]) {
      const png = await operator.inject({ method: "GET", url: path });
      expect(png.statusCode, path).toBe(200);
      expect(png.headers["content-type"], path).toBe("image/png");
      expect(png.headers["x-content-type-options"], path).toBe("nosniff");
    }
    // The agent skill (Account settings, "Connect an agent") is a public file of the build.
    const skill = await operator.inject({ method: "GET", url: "/agent-skill/SKILL.md" });
    expect(skill.statusCode).toBe(200);
    expect(skill.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(skill.body).toBe("# Deskmates\n");
    const head = await operator.inject({ method: "HEAD", url: "/assets/index-Ab12Cd34.js" });
    expect(head.statusCode).toBe(200);
  });

  it("falls back to index.html for unknown UI paths but not for a missing asset", async () => {
    const { operator } = await stack();
    const deep = await operator.inject({ method: "GET", url: "/threads/abc?x=1" });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["cache-control"]).toBe("no-cache");
    expect(deep.body).toBe(INDEX_HTML);
    const missing = await operator.inject({ method: "GET", url: "/assets/gone-00000000.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("<!doctype html>");
  });

  it("never falls back to the UI for API, webhook or sandbox-listener paths", async () => {
    const { operator } = await stack();
    for (const url of [
      "/api",
      "/api/",
      "/api/no-such-route",
      "/api/desktop-stream",
      "/hooks/bot/token",
      "/healthz",
      "/v1/messages",
      "/internal/runs/x/events",
    ]) {
      const res = await operator.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ code: "not_found" });
    }
  });

  it("keeps every registered /api route behind the operator credential", async () => {
    const { sandbox, operator } = await stack();
    // Walk the operator route table the same way operator-auth.test.ts does, then send each
    // route, unauthenticated, to the listener that also serves the static UI.
    const routeApp = Fastify();
    const routes: Array<{ method: string; url: string }> = [];
    routeApp.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (
          route.url.startsWith("/api/") &&
          !route.url.startsWith("/api/channel-webhooks/") &&
          method !== "HEAD"
        )
          routes.push({ method, url: route.url });
      }
    });
    registerOperatorRoutes(routeApp, sandbox.deskmates.ctx, sandbox.deskmates.scheduler);
    await routeApp.ready();
    await routeApp.close();
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      const url = route.url.replace(/:([A-Za-z0-9_]+)/g, "missing-$1").replace(/\*/g, "missing");
      const res = await operator.inject({
        method: route.method as "GET",
        url,
        ...(["GET", "HEAD", "DELETE"].includes(route.method) ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(res.body, `${route.method} ${route.url}`).not.toContain("<!doctype html>");
    }
    const authed = await operator.inject({
      method: "GET",
      url: "/api/config",
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    });
    expect(authed.statusCode).toBe(200);
  });

  it("does not serve the UI on the sandbox listener", async () => {
    const { sandbox } = await stack();
    for (const url of ["/", "/index.html", "/assets/index-Ab12Cd34.js", "/threads/abc"]) {
      const res = await sandbox.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain("<!doctype html>");
    }
  });

  it("serves nothing outside the directory, whatever the path encoding", async () => {
    const { operator } = await stack();
    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E%2Fsecret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/linked-secret.txt",
      "/index.html%00.js",
      "/%",
    ]) {
      const res = await raw(operator, path);
      expect(res.body, path).not.toContain(OUTSIDE_SECRET);
      // A traversal attempt is refused outright, never answered with the SPA fallback.
      expect([400, 404], path).toContain(res.status);
    }
  });

  it("serves nothing when WEB_DIST_DIR is unset", async () => {
    const { operator } = await stack({});
    expect((await operator.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    expect((await operator.inject({ method: "GET", url: "/index.html" })).statusCode).toBe(404);
  });

  it("refuses to start when the directory has no index.html", async () => {
    const empty = mkdtempSync(join(tmpdir(), "deskmates-static-empty-"));
    try {
      const sandbox = buildGateway(testConfig({ webDistDir: empty }), new FakeProvider(), {
        startCron: false,
      });
      apps.push(sandbox);
      expect(() => buildOperatorGateway(sandbox.deskmates)).toThrow(/WEB_DIST_DIR .*index\.html/);
      const missing = join(base, "does-not-exist");
      const sandbox2 = buildGateway(testConfig({ webDistDir: missing }), new FakeProvider(), {
        startCron: false,
      });
      apps.push(sandbox2);
      expect(() => buildOperatorGateway(sandbox2.deskmates)).toThrow(/WEB_DIST_DIR/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
