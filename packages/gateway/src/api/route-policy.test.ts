// T1: ADR-0022 P2 coverage manifest. Every operator route has exactly one access policy and every
// policy names a real route, so a route added without a tenant/role decision fails here (and is
// refused at runtime by the guard). The route walk uses Fastify's own route table.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { OPERATOR_ROUTE_RULES } from "./permission-matrix.js";
import { ROUTE_POLICY, ROUTE_POLICY_DOMAINS, mergeRoutePolicies } from "./route-policy.js";
import { registerOperatorRoutes } from "./routes.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function operatorRoutes(): Promise<string[]> {
  const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  apps.push(sandbox);
  await sandbox.ready();
  const app = Fastify();
  apps.push(app);
  const routes: string[] = [];
  // `/auth/preferences` (issue #22) and the account settings routes (ADR-0022 amendment 3) are
  // the routes outside `/api` registered behind the guard.
  const guarded = (url: string): boolean =>
    url.startsWith("/api/") || ["/auth/preferences", "/auth/profile", "/auth/avatar"].includes(url);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      if (method !== "HEAD" && guarded(route.url)) routes.push(`${method} ${route.url}`);
  });
  registerOperatorRoutes(app, sandbox.deskmates.ctx, sandbox.deskmates.scheduler);
  await app.ready();
  return routes;
}

describe("operator route manifest", () => {
  it("classifies every /api route, and names no route that does not exist", async () => {
    const routes = await operatorRoutes();
    // OAuth callback state and provider-authenticated channel webhooks sit outside the operator
    // credential guard. The permission matrix names every such route explicitly.
    const authenticated = routes.filter((route) => !(route in OPERATOR_ROUTE_RULES));
    const unclassified = authenticated.filter((route) => !(route in ROUTE_POLICY));
    expect(unclassified).toEqual([]);
    const stale = Object.keys(ROUTE_POLICY).filter((key) => !routes.includes(key));
    expect(stale).toEqual([]);
    expect(authenticated.length).toBe(Object.keys(ROUTE_POLICY).length);
  });

  it("declares a tenant-owned identifier for every path parameter of a tenant route", () => {
    // A parameter the guard does not resolve must be checked by its handler, and say so.
    for (const [key, policy] of Object.entries(ROUTE_POLICY)) {
      if (policy.access !== "tenant") continue;
      const params = [...key.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] as string);
      const undeclared = params.filter((p) => !(p in (policy.params ?? {})));
      const allowed =
        // Task ids are checked inside the guarded workspace by the task store.
        (key.includes("/tasks/:id") && undeclared.join() === "id") ||
        policy.handlerCheck !== undefined;
      if (undeclared.length > 0)
        expect(allowed, `${key} leaves ${undeclared.join()} unchecked`).toBe(true);
    }
  });
});

describe("route policy domains", () => {
  const domainFiles = readdirSync(fileURLToPath(new URL("./route-policies/", import.meta.url)))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "policy.ts")
    .map((file) => file.replace(/\.ts$/, ""));

  it("aggregates every domain file exactly once, in a sorted list", () => {
    const listed = ROUTE_POLICY_DOMAINS.map(([domain]) => domain);
    expect(listed).toEqual([...listed].sort());
    expect(listed).toEqual([...domainFiles].sort());
  });

  it("keeps every domain's policies in the aggregate", () => {
    const total = ROUTE_POLICY_DOMAINS.reduce(
      (sum, [, table]) => sum + Object.keys(table).length,
      0,
    );
    expect(Object.keys(ROUTE_POLICY).length).toBe(total);
    for (const [domain, table] of ROUTE_POLICY_DOMAINS)
      for (const [key, policy] of Object.entries(table))
        expect(ROUTE_POLICY[key], `${domain}: ${key}`).toBe(policy);
  });

  it("refuses a route declared by two domains", () => {
    const policy = { access: "authenticated" } as const;
    expect(() =>
      mergeRoutePolicies([
        ["a", { "GET /api/x": policy }],
        ["b", { "GET /api/x": policy }],
      ]),
    ).toThrow("GET /api/x is declared by both a and b");
  });
});
