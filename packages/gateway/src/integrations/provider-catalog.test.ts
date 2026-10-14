// T1: the operator's provider catalog (ADR-0013 amendment 3). The fake runtime behaves like
// OpenConnector v1.7.0: `GET /v1/providers` answers the admin token only until a runtime token
// exists, so the Gateway reads the list through `list_apps` under its own inert token.

import type { IntegrationCatalog } from "@deskmates/contracts";
import { FakeIntegrationRuntime } from "@deskmates/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHarness } from "../test-support/harness.js";
import {
  type IntegrationFixture,
  RUNTIME_ADMIN_TOKEN,
  RUNTIME_URL,
  integrationFixture,
} from "../test-support/integration-fixture.js";
import { CATALOG_TOKEN_NAME, CATALOG_TOKEN_POLICY } from "./integration-service.js";

let f: IntegrationFixture;

beforeEach(async () => {
  f = await integrationFixture();
});

afterEach(async () => {
  await f.close();
});

const catalog = () => f.h.api<IntegrationCatalog>("GET", "/api/integrations/catalog");
const mints = (fake: FakeIntegrationRuntime) =>
  fake.requests.filter((r) => r.method === "POST" && r.path === "/api/runtime-tokens");
const listAppsCalls = (fake: FakeIntegrationRuntime) =>
  fake.requests.filter((r) => r.path === "/mcp" && r.body.includes('"list_apps"'));

describe("provider catalog", () => {
  it("lists the whole runtime catalog through list_apps under a Gateway-owned inert token", async () => {
    const first = await catalog();
    expect(first.status).toBe(200);
    expect(first.json.complete).toBe(true);
    expect(first.json.providers.map((p) => p.service)).toContain("slack");
    expect(first.json.providers.every((p) => !p.adopted)).toBe(true);

    expect(mints(f.fake)).toHaveLength(1);
    expect(JSON.parse(mints(f.fake)[0]?.body ?? "{}")).toMatchObject({
      name: CATALOG_TOKEN_NAME,
      allowedActions: CATALOG_TOKEN_POLICY.allowedActions,
      allowedConnections: CATALOG_TOKEN_POLICY.allowedConnections,
    });
    const token = [...f.fake.tokens.values()].find((t) => t.name === CATALOG_TOKEN_NAME);
    expect(token).toBeDefined();
    expect(listAppsCalls(f.fake)).toHaveLength(1);
    expect(listAppsCalls(f.fake)[0]?.authorization).toBe(`Bearer ${token?.token}`);
    expect(f.fake.requests.some((r) => r.path === "/v1/providers")).toBe(false);

    // What v1.7.0 does once a token exists: the admin list is refused.
    const admin = await f.fake.fetch(`${RUNTIME_URL}/v1/providers`, {
      headers: { authorization: `Bearer ${RUNTIME_ADMIN_TOKEN}` },
    });
    expect(admin.status).toBe(401);

    // A second read reuses the stored token; the value sits in `secrets` under the gateway kind.
    const second = await catalog();
    expect(second.json.complete).toBe(true);
    expect(mints(f.fake)).toHaveLength(1);
    expect(listAppsCalls(f.fake)).toHaveLength(2);
    const rows = f.h.app.deskmates.ctx.db
      .prepare("SELECT owner_kind, owner_id FROM secrets WHERE owner_kind = 'gateway'")
      .all();
    expect(rows).toEqual([{ owner_kind: "gateway", owner_id: "integration-catalog" }]);
  });

  it("marks adopted providers first and re-mints the token once after the runtime forgot it", async () => {
    await f.adopt("slack");
    const before = await catalog();
    expect(before.json.providers[0]).toMatchObject({ service: "slack", adopted: true });
    expect(before.json.providers.filter((p) => p.adopted)).toHaveLength(1);

    // The runtime's data was reset: every token it issued is gone.
    f.fake.tokens.clear();
    const after = await catalog();
    expect(after.json.complete).toBe(true);
    expect(after.json.providers[0]?.service).toBe("slack");
    expect(mints(f.fake)).toHaveLength(2);
    expect(
      [...f.fake.tokens.values()].filter((t) => t.name === CATALOG_TOKEN_NAME && !t.revoked),
    ).toHaveLength(1);
    const count = f.h.app.deskmates.ctx.db
      .prepare("SELECT count(*) AS n FROM secrets WHERE owner_kind = 'gateway'")
      .get() as { n: number };
    expect(count.n).toBe(1);

    // A token the runtime still knows is not minted again on the next read.
    await catalog();
    expect(mints(f.fake)).toHaveLength(2);
  });

  it("falls back to the admin list only while the runtime has no token, else reports incompleteness", async () => {
    // No secrets store: the Gateway cannot hold a catalog token and must not mint one.
    const fake = new FakeIntegrationRuntime({
      baseUrl: RUNTIME_URL,
      adminToken: RUNTIME_ADMIN_TOKEN,
    });
    const h = await startHarness(
      { secretsKey: "", integrationRuntime: { url: RUNTIME_URL, adminToken: RUNTIME_ADMIN_TOKEN } },
      undefined,
      { integrationFetch: fake.fetch },
    );
    try {
      const fresh = await h.api<IntegrationCatalog>("GET", "/api/integrations/catalog");
      expect(fresh.json.complete).toBe(true);
      expect(fresh.json.providers.map((p) => p.service)).toContain("slack");
      expect(mints(fake)).toHaveLength(0);
      expect(fake.requests.filter((r) => r.path === "/v1/providers")).toHaveLength(1);

      // The runbook's bootstrap lock exists: the admin list is refused and nothing can be minted,
      // so the catalog says it is incomplete instead of pretending the runtime is empty.
      const lock = await fake.fetch(`${RUNTIME_URL}/api/runtime-tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${RUNTIME_ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "bootstrap-lock", ...CATALOG_TOKEN_POLICY }),
      });
      expect(lock.status).toBe(200);
      const locked = await h.api<IntegrationCatalog>("GET", "/api/integrations/catalog");
      expect(locked.json).toEqual({ configured: true, complete: false, providers: [] });
      expect(mints(fake)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
