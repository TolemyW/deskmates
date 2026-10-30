// T1, ADR-0055: a bot may be limited to some of its workspace's connected apps. The list is stored
// and audited through the bot patch, frozen on the run's first start, and enforced on every
// integration call before the runtime is asked. Metric: refusals by `app_not_enabled_for_bot`.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NOT_ENABLED_FOR_BOT, type IntegrationAppsResult } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITEA_KEY_A,
  type IntegrationFixture,
  integrationFixture,
} from "../test-support/integration-fixture.js";
import { appAllowed, frozenAppScope, startAppScope } from "./bot-app-scope.js";

let f: IntegrationFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup(): Promise<IntegrationFixture> {
  f = await integrationFixture();
  await f.adopt("gitea");
  await f.apiKey(f.a, "main", GITEA_KEY_A);
  return f;
}

describe("a bot's app access (ADR-0055)", () => {
  it("is every app by default, a stored list after a patch, audited, and every app again on null", async () => {
    const fx = await setup();
    const ctx = fx.h.app.deskmates.ctx;
    expect(fx.a.bot.integrationApps).toBeUndefined();
    const limited = await fx.h.api<{ bot: { integrationApps?: string[] } }>(
      "PATCH",
      `/api/bots/${fx.a.bot.id}`,
      { integrationApps: ["slack", "slack"] },
    );
    expect(limited.status).toBe(200);
    expect(limited.json.bot.integrationApps).toEqual(["slack"]);
    expect(ctx.bots.mustGet(fx.a.bot.id).integrationApps).toEqual(["slack"]);
    const audit = ctx.audit
      .list({ workspaceId: fx.a.workspace.id })
      .find((row) => row.action === "bot.update");
    expect(audit?.after).toMatchObject({ integrationApps: ["slack"] });
    expect(audit?.before).toMatchObject({ integrationApps: null });

    const invalid = await fx.h.api<{ code: string }>("PATCH", `/api/bots/${fx.a.bot.id}`, {
      integrationApps: ["Not a service!"],
    });
    expect(invalid.status).toBe(400);
    const reset = await fx.h.api("PATCH", `/api/bots/${fx.a.bot.id}`, { integrationApps: null });
    expect(reset.status).toBe(200);
    expect(ctx.bots.mustGet(fx.a.bot.id).integrationApps).toBeUndefined();
  });

  it("freezes on the run's first start and keeps the frozen value for a later process", async () => {
    const fx = await setup();
    const ctx = fx.h.app.deskmates.ctx;
    expect(frozenAppScope(fx.a.run.config)).toBeUndefined();
    expect(appAllowed(undefined, "gitea")).toBe(true);
    const frozen = startAppScope(ctx.runs, fx.a.run, { integrationApps: ["slack"] });
    expect(frozen).toEqual(["slack"]);
    const stored = ctx.runs.mustGet(fx.a.run.id);
    expect(stored.config.integrationApps).toEqual(["slack"]);
    // The bot changes; the run keeps what it started with.
    expect(startAppScope(ctx.runs, stored, {})).toEqual(["slack"]);
    // A run already past its first start without the key has every app.
    expect(startAppScope(ctx.runs, { ...fx.b.run, attempt: 2 }, { integrationApps: [] })).toBe(
      "all",
    );
  });

  it("refuses another app's calls before the runtime is asked and lists only allowed apps", async () => {
    const fx = await setup();
    const ctx = fx.h.app.deskmates.ctx;
    ctx.runs.setConfig(fx.a.run.id, { integrationApps: ["slack"] });
    const apps = await fx.run<IntegrationAppsResult>(fx.a, "GET", "/apps");
    expect(apps.status).toBe(200);
    expect(apps.json.apps.map((app) => app.service)).not.toContain("gitea");

    const before = fx.fake.requests.length;
    for (const [method, path, body] of [
      ["POST", "/search", { service: "gitea", query: "repos" }],
      ["POST", "/guide", { actionId: "gitea.list_my_repositories" }],
      ["POST", "/execute", { actionId: "gitea.list_my_repositories", input: {} }],
    ] as const) {
      const res = await fx.run<{ code: string; details?: { reason?: string; service?: string } }>(
        fx.a,
        method,
        path,
        body,
      );
      expect(res.status, path).toBe(403);
      expect(res.json.details).toMatchObject({ reason: APP_NOT_ENABLED_FOR_BOT, service: "gitea" });
    }
    expect(fx.fake.requests.slice(before).some((r) => r.path === "/mcp")).toBe(false);
    expect(fx.fake.executions).toEqual([]);
  });

  it("offers the tools only when an allowed app is connected", async () => {
    const fx = await setup();
    const integrations = fx.h.app.deskmates.ctx.integrations;
    expect(integrations.usableConnectionCountFor(fx.a.workspace.id, "all")).toBe(1);
    expect(integrations.usableConnectionCountFor(fx.a.workspace.id, ["gitea"])).toBe(1);
    expect(integrations.usableConnectionCountFor(fx.a.workspace.id, ["slack"])).toBe(0);
    expect(integrations.usableConnectionCountFor(fx.a.workspace.id, [])).toBe(0);
  });

  it("still executes an allowed app", async () => {
    const fx = await setup();
    fx.h.app.deskmates.ctx.runs.setConfig(fx.a.run.id, { integrationApps: ["gitea"] });
    const res = await fx.run<{ ok: boolean }>(fx.a, "POST", "/execute", {
      actionId: "gitea.list_my_repositories",
      connectionName: "main",
      input: {},
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});

it("is raised only by the integration service: no other tool call is refused for it", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const raisers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        if (readFileSync(path, "utf8").includes("APP_NOT_ENABLED_FOR_BOT"))
          raisers.push(path.slice(src.length));
    }
  };
  walk(src);
  expect(raisers).toEqual(["integrations/integration-service.ts"]);
});
