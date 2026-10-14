// T1: ADR-0006 operator authentication and listener separation. The route walk is populated by
// Fastify's onRoute hook, so a later `/api/*` registration is covered without editing this test.

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";
import { registerErrorHandler } from "./errors.js";
import { registerOperatorAuth } from "./operator-auth.js";
import { OPERATOR_ROUTE_RULES } from "./permission-matrix.js";
import { registerOperatorRoutes } from "./routes.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function pathForInject(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "missing-$1").replace(/\*/g, "missing");
}

describe("operator authentication", () => {
  it("rejects every registered /api route without the operator credential", async () => {
    const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    apps.push(sandbox);
    await sandbox.ready();
    const routeApp = Fastify();
    const routes: Array<{ method: string; url: string }> = [];
    routeApp.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (
          route.url.startsWith("/api/") &&
          method !== "HEAD" &&
          !(`${method} ${route.url}` in OPERATOR_ROUTE_RULES)
        )
          routes.push({ method, url: route.url });
      }
    });
    registerOperatorRoutes(routeApp, sandbox.deskmates.ctx, sandbox.deskmates.scheduler);
    await routeApp.ready();
    try {
      expect(routes.length).toBeGreaterThan(20);
      for (const route of routes) {
        const response = await routeApp.inject({
          method: route.method as "GET",
          url: pathForInject(route.url),
          ...(["GET", "HEAD", "DELETE"].includes(route.method) ? {} : { payload: {} }),
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      }
    } finally {
      await routeApp.close();
    }
  });

  it("keeps operator and run credentials confined to their own route families", async () => {
    const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    const operator = buildOperatorGateway(sandbox.deskmates);
    apps.push(operator, sandbox);
    await Promise.all([sandbox.ready(), operator.ready()]);
    expect(operator.deskmates).toBe(sandbox.deskmates);
    sandbox.deskmates.scheduler.stop();

    const ctx = sandbox.deskmates.ctx;
    const workspace = ctx.workspaces.create({ name: "auth", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ name: "authbot", role: "test", workspaceId: workspace.id });
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "auth-test",
      triggerPayload: { body: "test" },
      config: ctx.runConfig(),
    });
    const runToken = ctx.tokens.issue(run.id).token;

    expect((await operator.inject({ method: "GET", url: "/api/workspaces" })).statusCode).toBe(401);
    expect(
      (
        await operator.inject({
          method: "GET",
          url: "/api/workspaces",
          headers: { authorization: `Bearer ${runToken}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await operator.inject({
          method: "GET",
          url: "/api/workspaces",
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
        })
      ).statusCode,
    ).toBe(200);

    // The per-run context metrics (M3 context plan, Phase 1) are an operator route: the run's own
    // token cannot read them, even for its own run, and the sandbox listener does not serve them.
    const contextUrl = `/api/runs/${run.id}/context`;
    expect(
      (
        await operator.inject({
          method: "GET",
          url: contextUrl,
          headers: { authorization: `Bearer ${runToken}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await sandbox.inject({
          method: "GET",
          url: contextUrl,
          headers: { authorization: `Bearer ${runToken}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await operator.inject({
          method: "GET",
          url: contextUrl,
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
        })
      ).statusCode,
    ).toBe(200);

    expect((await sandbox.inject({ method: "GET", url: "/api/workspaces" })).statusCode).toBe(404);
    expect(
      (await sandbox.inject({ method: "POST", url: "/hooks/missing/token", payload: "x" }))
        .statusCode,
    ).toBe(404);
    // Webhooks are external ingress on the operator listener, authenticated by their per-bot
    // path token rather than by either Bearer credential.
    expect(
      (await operator.inject({ method: "POST", url: "/hooks/missing/token", payload: "x" }))
        .statusCode,
    ).toBe(404);
    expect((await operator.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(404);
    expect(
      (await operator.inject({ method: "POST", url: "/v1/messages", payload: {} })).statusCode,
    ).toBe(404);
    expect(
      (
        await operator.inject({
          method: "POST",
          url: `/internal/runs/${run.id}/events`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await sandbox.inject({
          method: "POST",
          url: `/internal/runs/${run.id}/events`,
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await sandbox.inject({
          method: "POST",
          url: "/v1/messages",
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });

  it("keeps connector routes split: a run token cannot list connectors, another run's gets 403", async () => {
    const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    const operator = buildOperatorGateway(sandbox.deskmates);
    apps.push(operator, sandbox);
    await Promise.all([sandbox.ready(), operator.ready()]);
    sandbox.deskmates.scheduler.stop();
    const ctx = sandbox.deskmates.ctx;
    const workspace = ctx.workspaces.create({ name: "conn", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ name: "connbot", role: "test", workspaceId: workspace.id });
    const mkRun = () =>
      ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: "auth-test",
        triggerPayload: { body: "test" },
        config: ctx.runConfig(),
      });
    const own = mkRun();
    const other = mkRun();
    const runToken = ctx.tokens.issue(own.id).token;

    for (const [method, url] of [
      ["GET", "/api/connectors"],
      ["POST", "/api/connectors"],
    ] as const) {
      const res = await operator.inject({
        method,
        url,
        headers: { authorization: `Bearer ${runToken}` },
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    // Operator connector routes are not on the sandbox listener at all.
    expect(
      (
        await sandbox.inject({
          method: "GET",
          url: "/api/connectors",
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
        })
      ).statusCode,
    ).toBe(404);
    // Run connector routes are not on the operator listener.
    expect(
      (
        await operator.inject({
          method: "POST",
          url: `/internal/runs/${own.id}/connectors/x/describe`,
          headers: { authorization: `Bearer ${runToken}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    for (const path of [
      "describe",
      "validate",
      "submit",
      "status/rcpt-1",
      "receipt/rcpt-1",
      "validations/val-1",
    ]) {
      const post = !path.includes("/");
      const res = await sandbox.inject({
        method: post ? "POST" : "GET",
        url: `/internal/runs/${other.id}/connectors/x/${path}`,
        headers: { authorization: `Bearer ${runToken}` },
        ...(post ? { payload: {} } : {}),
      });
      expect(res.statusCode, path).toBe(403);
    }
    expect(
      (
        await sandbox.inject({
          method: "POST",
          url: `/internal/runs/${own.id}/connectors/x/describe`,
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });

  it("keeps integration routes split: run tokens reach only their own run's routes (ADR-0013 rows 4 and 5)", async () => {
    const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    const operator = buildOperatorGateway(sandbox.deskmates);
    apps.push(operator, sandbox);
    await Promise.all([sandbox.ready(), operator.ready()]);
    sandbox.deskmates.scheduler.stop();
    const ctx = sandbox.deskmates.ctx;
    const workspace = ctx.workspaces.create({ name: "int", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ name: "intbot", role: "test", workspaceId: workspace.id });
    const mkRun = () =>
      ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: "auth-test",
        triggerPayload: { body: "test" },
        config: ctx.runConfig(),
      });
    const own = mkRun();
    const other = mkRun();
    const runToken = ctx.tokens.issue(own.id).token;

    const operatorRoutes = [
      ["GET", "/api/integrations"],
      ["POST", "/api/integrations/providers"],
      ["GET", `/api/integrations/workspaces/${workspace.id}/connections`],
      ["POST", `/api/integrations/workspaces/${workspace.id}/connections/api-key`],
      ["POST", `/api/integrations/workspaces/${workspace.id}/connections/oauth/start`],
      ["PUT", "/api/integrations/actions/slack.post_message/override"],
    ] as const;
    for (const [method, url] of operatorRoutes) {
      const res = await operator.inject({
        method,
        url,
        headers: { authorization: `Bearer ${runToken}` },
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      const onSandbox = await sandbox.inject({
        method,
        url,
        headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(onSandbox.statusCode, `sandbox ${method} ${url}`).toBe(404);
    }
    // The OAuth callback takes no Bearer credential; its one-time state is the credential.
    const callback = "/api/integrations/oauth/callback?state=forged&code=x";
    expect((await operator.inject({ method: "GET", url: callback })).statusCode).toBe(401);
    expect(
      (
        await operator.inject({
          method: "GET",
          url: callback,
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await sandbox.inject({ method: "GET", url: callback })).statusCode).toBe(404);

    const runRoutes = [
      ["GET", "apps"],
      ["GET", "connections"],
      ["POST", "search"],
      ["POST", "guide"],
      ["POST", "execute"],
      ["GET", "actions/slack.post_message/tier"],
    ] as const;
    for (const [method, path] of runRoutes) {
      const payload = method === "POST" ? { payload: {} } : {};
      const otherRun = await sandbox.inject({
        method,
        url: `/internal/runs/${other.id}/integrations/${path}`,
        headers: { authorization: `Bearer ${runToken}` },
        ...payload,
      });
      expect(otherRun.statusCode, path).toBe(403);
      const withOperator = await sandbox.inject({
        method,
        url: `/internal/runs/${own.id}/integrations/${path}`,
        headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
        ...payload,
      });
      expect(withOperator.statusCode, path).toBe(401);
      const onOperator = await operator.inject({
        method,
        url: `/internal/runs/${own.id}/integrations/${path}`,
        headers: { authorization: `Bearer ${runToken}` },
        ...payload,
      });
      expect(onOperator.statusCode, path).toBe(404);
    }
    // Its own run's route is reached: with no runtime configured it says so.
    const ownRun = await sandbox.inject({
      method: "GET",
      url: `/internal/runs/${own.id}/integrations/apps`,
      headers: { authorization: `Bearer ${runToken}` },
    });
    expect(ownRun.statusCode).toBe(503);
    expect(ownRun.json().code).toBe("integration_unavailable");
  });

  it("serves workspace file downloads on the operator listener only (ADR-0014 item 1)", async () => {
    const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    const operator = buildOperatorGateway(sandbox.deskmates);
    apps.push(operator, sandbox);
    await Promise.all([sandbox.ready(), operator.ready()]);
    sandbox.deskmates.scheduler.stop();
    const ctx = sandbox.deskmates.ctx;
    const workspace = ctx.workspaces.create({ name: "files", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ name: "filebot", role: "test", workspaceId: workspace.id });
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "auth-test",
      triggerPayload: { body: "test" },
      config: ctx.runConfig(),
    });
    const runToken = ctx.tokens.issue(run.id).token;
    const url = `/api/workspaces/${workspace.id}/files?path=${encodeURIComponent("/work/a.md")}`;

    expect((await operator.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (
        await operator.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${runToken}` },
        })
      ).statusCode,
    ).toBe(401);
    // The query credential is for EventSource only; a download link cannot carry it.
    expect(
      (
        await operator.inject({
          method: "GET",
          url: `${url}&token=${encodeURIComponent(TEST_OPERATOR_TOKEN)}`,
        })
      ).statusCode,
    ).toBe(401);
    for (const authorization of [`Bearer ${runToken}`, `Bearer ${TEST_OPERATOR_TOKEN}`]) {
      expect(
        (await sandbox.inject({ method: "GET", url, headers: { authorization } })).statusCode,
      ).toBe(404);
    }
    // Authenticated, it reaches the route: the workspace has no container, so it is reported.
    const authorized = await operator.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    });
    expect(authorized.statusCode).toBe(404);
    expect(authorized.json().details).toEqual({ reason: "workspace_not_running" });

    // ADR-0014 amendment A2: the Files collection is an operator route too; a run token never
    // reads it, and it lists a stopped workspace without starting it.
    const assets = `/api/workspaces/${workspace.id}/assets`;
    for (const headers of [{}, { authorization: `Bearer ${runToken}` }])
      expect((await operator.inject({ method: "GET", url: assets, headers })).statusCode).toBe(401);
    const listed = await operator.inject({
      method: "GET",
      url: assets,
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().total).toBe(0);
  });

  it("never accepts the operator credential in a URL, including the SSE endpoint", async () => {
    const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    apps.push(sandbox);
    await sandbox.ready();
    const app = Fastify();
    registerErrorHandler(app);
    app.register(async (scope) => {
      registerOperatorAuth(scope, sandbox.deskmates.ctx);
      scope.get("/api/events", async () => ({ connected: true }));
      scope.get("/api/workspaces", async () => ({ workspaces: [] }));
    });
    await app.ready();
    for (const path of ["/api/workspaces", "/api/events"]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${path}?token=${encodeURIComponent(TEST_OPERATOR_TOKEN)}`,
          })
        ).statusCode,
        path,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: path,
            headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
          })
        ).statusCode,
        path,
      ).toBe(200);
    }
    await app.close();
  });
});
