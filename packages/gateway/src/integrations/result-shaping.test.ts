// T0/T1: result shaping (ADR-0013 Amendment 1, item 5). A search always names a service, is capped
// at five and keeps adopted providers only; the run never sees runtime connection names, virtual
// no-auth connections or the unfiltered app list.

import type {
  IntegrationAppsResult,
  IntegrationGuideResult,
  IntegrationSearchResult,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITEA_KEY_A,
  type IntegrationFixture,
  integrationFixture,
} from "../test-support/integration-fixture.js";
import { searchLimit, shapeSearch } from "./result-shaping.js";
import type { RuntimeActionEntry } from "./runtime-adapter.js";

let f: IntegrationFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const entry = (actionId: string): RuntimeActionEntry => ({
  actionId,
  service: actionId.split(".")[0] as string,
  name: actionId.split(".").slice(1).join("."),
  description: "d",
  operationType: "read",
  requiredScopes: [],
  inputs: [],
});

describe("pure shaping", () => {
  it("clamps the limit to 1..5", () => {
    expect(searchLimit(undefined)).toBe(5);
    expect(searchLimit(50)).toBe(5);
    expect(searchLimit(0)).toBe(1);
    expect(searchLimit(2.7)).toBe(2);
    expect(searchLimit("9")).toBe(5);
  });

  it("keeps entries of the service and adopted providers only", () => {
    const shaped = shapeSearch(
      "slack",
      [entry("slack.a"), entry("slackbot.b"), entry("slack.c"), entry("slack.d")],
      new Set(["slack"]),
      2,
    );
    expect(shaped.actions.map((a) => a.actionId)).toEqual(["slack.a", "slack.c"]);
    expect(shapeSearch("slack", [entry("slack.a")], new Set(), 5).actions).toEqual([]);
  });
});

describe("shaping on the run routes", () => {
  it("requires a service, caps the runtime's limit at five and drops the capability object", async () => {
    f = await integrationFixture();
    const fx = f;
    await fx.adopt("googledrive");
    await fx.adopt("gitea");
    await fx.apiKey(fx.a, "main", GITEA_KEY_A);
    expect((await fx.run(fx.a, "POST", "/search", { query: "file" })).status).toBe(400);
    const res = await fx.run<IntegrationSearchResult>(fx.a, "POST", "/search", {
      service: "googledrive",
      query: "",
      limit: 40,
    });
    expect(res.status).toBe(200);
    expect(res.json.actions.length).toBeLessThanOrEqual(5);
    expect(res.json.actions.every((a) => a.service === "googledrive")).toBe(true);
    const mcp = fx.fake.requests.filter((r) => r.path === "/mcp").map((r) => JSON.parse(r.body));
    const search = mcp.find((m) => m.params?.name === "search_actions");
    expect(search.params.arguments).toMatchObject({ service: "googledrive", limit: 5 });
    expect(JSON.stringify(res.json)).not.toContain("capability");
    const notAdopted = await fx.run<{ code: string }>(fx.a, "POST", "/search", {
      service: "slack",
    });
    expect(notAdopted.json.code).toBe("integration_not_adopted");
  });

  it("lists adopted providers without calling list_apps, and guides under the bot's name", async () => {
    f = await integrationFixture();
    const fx = f;
    await fx.adopt("gitea");
    await fx.apiKey(fx.a, "main", GITEA_KEY_A);
    const apps = await fx.run<IntegrationAppsResult>(fx.a, "GET", "/apps");
    expect(apps.json).toEqual({
      apps: [{ service: "gitea", displayName: "gitea", connections: ["main"] }],
    });
    const guide = await fx.run<IntegrationGuideResult>(fx.a, "POST", "/guide", {
      actionId: "gitea.list_my_repositories",
    });
    expect(guide.json.connectionName).toBe("main");
    expect(guide.json.guide).toContain("main (api_key)");
    expect(guide.json.guide).not.toMatch(/g[0-9a-f]{10}-main/);
    const tools = fx.fake.requests
      .filter((r) => r.path === "/mcp")
      .map((r) => JSON.parse(r.body).params?.name);
    expect(tools).not.toContain("list_apps");
  });
});
