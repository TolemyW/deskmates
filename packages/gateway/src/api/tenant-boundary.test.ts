// T1: ADR-0022 P2 tenant boundary (test plan DATA-01, DATA-02, DATA-03, ROLE-01, AUDIT-01).
//
// Two tenants, each with one row of every tenant-owned kind and a signed-in Owner. For every
// route in the manifest that names tenant-owned identifiers, tenant B substitutes A's
// identifiers (path, query and body). Each call must get the uniform 404 that a missing id gets
// (no existence leak), and the database must be byte-for-byte unchanged afterwards (no side
// effect). Every denial is paired with A's own call passing the guard, so a broken route cannot
// pass for isolation. Lists, counts and full-text search are checked with sentinel text.

import type { RunId } from "@deskmates/contracts";
import { CSRF_HEADER } from "@deskmates/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardStore } from "../board/board-store.js";
import { buildGateway } from "../index.js";
import type { OwnedKind } from "../tenancy/ownership.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";
import {
  FIXTURE_PASSWORD,
  type TenantFixture,
  seedTenant,
  snapshotDatabase,
} from "../test-support/tenants.js";
import { ROUTE_POLICY, type RoutePolicy } from "./route-policy.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";
const DENIAL = { code: "not_found", message: "Not found", details: {} };
/** Each tenant's board post id, by tenant id. */
const boardPosts = new Map<string, string>();

let app: FastifyInstance;
let A: TenantFixture;
let B: TenantFixture;

beforeAll(async () => {
  app = buildGateway(
    testConfig({
      secretsKey: Buffer.alloc(32, 7).toString("base64"),
      auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
    }),
    new FakeProvider(),
    { surface: "combined-test", startCron: false },
  );
  await app.ready();
  app.deskmates.scheduler.stop();
  A = await seedTenant(app.deskmates.ctx, "A");
  B = await seedTenant(app.deskmates.ctx, "B");
  // A board post of each tenant's workspace, for the board routes' `:postId` (amendment 6 W10).
  for (const tenant of [A, B])
    boardPosts.set(
      tenant.tenantId,
      new BoardStore(app.deskmates.ctx.db).post({
        workspaceId: tenant.ids.workspace,
        authorUserId: tenant.ownerUserId,
        body: "a board post",
      }).id,
    );
});
afterAll(async () => {
  await app.close();
});

function as(
  who: TenantFixture | { token: string; csrf: string },
  method: string,
  url: string,
  payload?: unknown,
  extra: Record<string, string> = {},
) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: {
      cookie: `${SESSION}=${who.token}`,
      host: HOST,
      origin: `http://${HOST}`,
      [CSRF_HEADER]: who.csrf,
      ...extra,
    },
  };
  if (payload !== undefined) options.payload = payload;
  // Arbitrary JSON bodies: the inject typing wants a narrower payload type than tests need.
  return app.inject(options as unknown as InjectOptions);
}

type TenantPolicy = Extract<RoutePolicy, { access: "tenant" }>;

/** The request a route walk sends: `owner`'s identifiers in every declared position. */
function requestFor(key: string, policy: TenantPolicy, owner: TenantFixture) {
  const [method, path] = key.split(" ") as [string, string];
  const params: Record<string, string> = {};
  for (const [name, kind] of Object.entries(policy.params ?? {})) params[name] = owner.ids[kind];
  let url = path.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
    encodeURIComponent(
      params[name] ??
        (name === "id" && path.includes("/tasks/")
          ? owner.ids.task
          : name === "postId"
            ? (boardPosts.get(owner.tenantId) ?? "none-postId")
            : `none-${name}`),
    ),
  );
  const query = Object.entries(policy.query ?? {}).map(
    ([name, kind]) => `${name}=${encodeURIComponent(owner.ids[kind as OwnedKind])}`,
  );
  if (query.length > 0) url += `?${query.join("&")}`;
  const body: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(policy.body ?? {})) {
    const many = ref.endsWith("[]");
    const kind = (many ? ref.slice(0, -2) : ref) as OwnedKind;
    body[name] = many ? [owner.ids[kind]] : owner.ids[kind];
  }
  const sendsBody = !["GET", "DELETE"].includes(method);
  return { method, url, body: sendsBody ? body : undefined };
}

/** Routes with at least one tenant-owned identifier the guard resolves. */
function identifiedRoutes(): Array<[string, TenantPolicy]> {
  return Object.entries(ROUTE_POLICY).filter(
    (entry): entry is [string, TenantPolicy] =>
      entry[1].access === "tenant" &&
      Object.keys({ ...entry[1].params, ...entry[1].query, ...entry[1].body }).length > 0 &&
      // A route whose only identifiers are optional list filters is covered by the list test.
      !(entry[1].scopedList && !entry[1].params && !entry[1].body),
  );
}

describe("DATA-01: another tenant's identifiers", () => {
  it("every route answers B's use of A's ids exactly like a missing id, with no side effect", async () => {
    const routes = identifiedRoutes();
    expect(routes.length).toBeGreaterThan(60);
    const before = snapshotDatabase(app.deskmates.ctx);
    for (const [key, policy] of routes) {
      const request = requestFor(key, policy, A);
      const foreign = await as(B, request.method, request.url, request.body);
      expect(foreign.statusCode, `${key} as B with A's ids`).toBe(404);
      expect(foreign.json(), key).toEqual(DENIAL);
      // Same answer for an identifier that does not exist anywhere.
      const missing = requestFor(key, policy, {
        ...A,
        ids: Object.fromEntries(
          Object.keys(A.ids).map((k) => [k, `missing_${k}`]),
        ) as TenantFixture["ids"],
      });
      const absent = await as(B, missing.method, missing.url, missing.body);
      expect(absent.statusCode, `${key} missing id`).toBe(404);
      expect(absent.json(), key).toEqual(DENIAL);
    }
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
  });

  it("every route lets A use its own ids past the guard (positive control)", async () => {
    for (const [key, policy] of identifiedRoutes()) {
      const request = requestFor(key, policy, A);
      const own = await as(A, request.method, request.url, request.body);
      const body =
        own.body.length > 0 && own.headers["content-type"]?.toString().includes("json")
          ? own.json()
          : undefined;
      expect(body, `${key} as A must not be the tenant denial`).not.toEqual(DENIAL);
    }
  });

  it("mixing a own workspace with a foreign bot in one body is refused atomically", async () => {
    const before = snapshotDatabase(app.deskmates.ctx);
    const thread = await as(B, "POST", "/api/threads", {
      workspaceId: B.ids.workspace,
      botIds: [B.ids.bot, A.ids.bot],
    });
    expect(thread.statusCode).toBe(404);
    const bot = await as(B, "POST", "/api/bots", {
      name: "intruder",
      workspaceId: A.ids.workspace,
    });
    expect(bot.statusCode).toBe(404);
    const task = await as(B, "POST", `/api/workspaces/${B.ids.workspace}/tasks`, {
      title: "cross",
      ownerBotId: A.ids.bot,
      runIds: [A.ids.run],
    });
    expect(task.statusCode).toBeGreaterThanOrEqual(400);
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
  });
});

describe("DATA-01: identifiers the guard cannot resolve", () => {
  it("refuses a repeated query key or a non-string id before the handler runs", async () => {
    const before = snapshotDatabase(app.deskmates.ctx);
    // A repeated query key arrives as an array: own id first, foreign id second.
    const repeated = await as(
      B,
      "GET",
      `/api/bots?workspaceId=${B.ids.workspace}&workspaceId=${A.ids.workspace}`,
    );
    expect(repeated.statusCode).toBe(400);
    expect(repeated.body).not.toContain(A.sentinel);
    const objectId = await as(B, "POST", "/api/bots", {
      name: "intruder",
      role: "r",
      workspaceId: { id: A.ids.workspace },
    });
    expect(objectId.statusCode).toBe(400);
    const mixedArray = await as(B, "POST", "/api/threads", {
      workspaceId: B.ids.workspace,
      botIds: [B.ids.bot, 7],
    });
    expect(mixedArray.statusCode).toBe(400);
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
  });
});

describe("DATA-02: lists, counts and search stay inside the tenant", () => {
  const LISTS = [
    "/api/workspaces",
    "/api/bots",
    "/api/threads",
    "/api/runs",
    "/api/approvals",
    "/api/approvals?status=decided",
    "/api/costs",
    "/api/cost-alert-rules",
    "/api/cost-alerts?status=all",
    "/api/memory-suggestions",
    "/api/memory/versions?refs=",
    "/api/knowledge",
    "/api/knowledge/proposals",
    "/api/connectors",
  ];

  it("no list shows another tenant's rows; each shows the caller's own", async () => {
    for (const path of LISTS) {
      const url = path.endsWith("refs=") ? `${path}${A.ids.memoryEntry}@1` : path;
      const asB = await as(B, "GET", url);
      expect(asB.statusCode, url).toBe(200);
      for (const id of Object.values(A.ids))
        expect(asB.body, `${url} leaks ${id}`).not.toContain(id);
      expect(asB.body, url).not.toContain(A.sentinel);
    }
    const own = (await as(A, "GET", "/api/workspaces")).json().workspaces as Array<{ id: string }>;
    expect(own.map((w) => w.id)).toEqual([A.ids.workspace]);
    expect((await as(A, "GET", "/api/connectors")).body).toContain(A.ids.connector);
    // The positive-control walk cancels A's run, which closes its approval: pending or decided,
    // A still sees it.
    const approvals = [
      (await as(A, "GET", "/api/approvals")).body,
      (await as(A, "GET", "/api/approvals?status=decided")).body,
    ].join();
    expect(approvals).toContain(A.ids.approval);
    expect((await as(A, "GET", `/api/memory/versions?refs=${A.ids.memoryEntry}@1`)).body).toContain(
      A.ids.memoryEntry,
    );
  });

  it("Knowledge full-text search ranks only the caller's tenant", async () => {
    const own = await as(A, "GET", `/api/knowledge?q=${A.sentinel}`);
    expect(own.json().documents.map((d: { id: string }) => d.id)).toEqual([A.ids.knowledgeDoc]);
    const foreign = await as(B, "GET", `/api/knowledge?q=${A.sentinel}`);
    expect(foreign.json().documents).toEqual([]);
  });

  it("a run reads its own tenant's Knowledge, never another's", async () => {
    const ctx = app.deskmates.ctx;
    const runToken = ctx.tokens.issue(B.ids.run as RunId).token;
    const headers = { authorization: `Bearer ${runToken}` };
    const search = await app.inject({
      method: "GET",
      url: `/internal/runs/${B.ids.run}/knowledge/search?q=${A.sentinel}`,
      headers,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().documents).toEqual([]);
    const read = await app.inject({
      method: "GET",
      url: `/internal/runs/${B.ids.run}/knowledge/${A.ids.knowledgeDoc}`,
      headers,
    });
    expect(read.statusCode).toBe(404);
    const proposed = await app.inject({
      method: "POST",
      url: `/internal/runs/${B.ids.run}/knowledge/proposals`,
      headers,
      payload: { title: "from B", body: "B's run proposes" },
    });
    expect(proposed.statusCode).toBe(201);
    const proposals = (await as(A, "GET", "/api/knowledge/proposals")).body;
    expect(proposals).not.toContain(proposed.json().proposal.id);
  });

  it("cost reports total only the caller's tenant's usage", async () => {
    const ctx = app.deskmates.ctx;
    ctx.usage.record(
      A.ids.run as RunId,
      1,
      [
        {
          model: "model-a",
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      ],
      new Date().toISOString(),
    );
    const asA = (await as(A, "GET", "/api/costs")).json();
    const asB = (await as(B, "GET", "/api/costs")).json();
    expect(asA.totals.inputTokens).toBe(1000);
    expect(asB.totals.inputTokens).toBe(0);
    expect(asB.totals.usageCount).toBe(0);
  });
});

describe("DATA-03: the database refuses cross-workspace rows below every route", () => {
  it("rejects a thread member, run or task owner from another workspace", () => {
    const db = app.deskmates.ctx.db;
    expect(() =>
      db
        .prepare("INSERT INTO thread_members (thread_id, bot_id, joined_at) VALUES (?, ?, 'x')")
        .run(B.ids.thread, A.ids.bot),
    ).toThrow(/another workspace/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO runs (id, workspace_id, bot_id, thread_id, lane, trigger_kind, trigger_ref, status, created_at) VALUES ('r_x', ?, ?, ?, 'interactive', 'thread_message', 'x', 'queued', 'x')",
        )
        .run(A.ids.workspace, A.ids.bot, B.ids.thread),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare("UPDATE tasks SET owner_bot_id = ? WHERE id = ?").run(A.ids.bot, B.ids.task),
    ).toThrow(/another workspace/);
    expect(() =>
      db
        .prepare("UPDATE workspaces SET tenant_id = ? WHERE id = ?")
        .run(A.tenantId, B.ids.workspace),
    ).toThrow(/cannot move/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO knowledge_docs (id, path, title, body, approved_by, updated_at, version) VALUES ('kb_x', 'p', 't', 'b', 'h', 'x', 1)",
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed: knowledge_docs.tenant_id/);
  });
});

describe("ROLE-01: tenant roles and platform maintenance", () => {
  async function memberOf(tenant: TenantFixture, role: "member" | "admin", name: string) {
    const ctx = app.deskmates.ctx;
    await ctx.auth.createUser({
      loginName: name,
      displayName: name,
      password: FIXTURE_PASSWORD,
      role,
      tenantId: tenant.tenantId,
    });
    const { token } = await ctx.auth.login(name, FIXTURE_PASSWORD, name);
    const { csrfTokenFor } = await import("../auth/tokens.js");
    return { token, csrf: csrfTokenFor(token) };
  }

  it("a Member uses the tenant but cannot change its configuration, with no side effect", async () => {
    const member = await memberOf(A, "member", "member-a");
    expect((await as(member, "GET", `/api/workspaces/${A.ids.workspace}`)).statusCode).toBe(200);
    const before = snapshotDatabase(app.deskmates.ctx);
    const refused: Array<[string, string, unknown?]> = [
      ["POST", "/api/workspaces", { name: "member-made" }],
      ["PATCH", `/api/workspaces/${A.ids.workspace}`, { egressAllowlist: ["*"] }],
      ["PATCH", `/api/bots/${A.ids.bot}`, { role: "changed" }],
      ["POST", `/api/bots/${A.ids.bot}/approval-rules`, { decision: "allow_always", matcher: {} }],
      ["DELETE", `/api/approval-rules/${A.ids.approvalRule}`],
      [
        "POST",
        "/api/connectors",
        { workspaceId: A.ids.workspace, name: "x", url: "https://x.example.test/" },
      ],
      ["PATCH", `/api/knowledge/${A.ids.knowledgeDoc}`, { title: "t", body: "b", version: 1 }],
    ];
    for (const [method, url, body] of refused) {
      const response = await as(member, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
  });

  it("a tenant Owner without platform maintenance cannot use platform routes", async () => {
    const before = snapshotDatabase(app.deskmates.ctx);
    for (const [method, url, body] of [
      ["GET", "/api/runtime"],
      ["PUT", "/api/prices", { prices: [] }],
      ["POST", "/api/integrations/providers", { service: "github" }],
      ["PUT", "/api/integrations/actions/x/override", { lowerableToL1: true }],
      ["POST", "/api/knowledge/versions/cleanup"],
    ] as Array<[string, string, unknown?]>) {
      expect((await as(A, method, url, body)).statusCode, url).toBe(403);
    }
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
    const platform = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    });
    expect(platform.statusCode).toBe(200);
  });

  it("a user's tenant selector cannot reach a tenant they do not belong to", async () => {
    const asForeign = await as(A, "GET", "/api/workspaces", undefined, {
      "x-deskmates-tenant": B.tenantId,
    });
    expect(asForeign.statusCode).toBe(401);
    const asOwn = await as(A, "GET", "/api/workspaces", undefined, {
      "x-deskmates-tenant": A.tenantId,
    });
    expect(asOwn.json().workspaces.map((w: { id: string }) => w.id)).toEqual([A.ids.workspace]);
  });
});

describe("AUDIT-01: the actor comes from the session, not the body", () => {
  it("records user:<id> however the body names its author", async () => {
    const ctx = app.deskmates.ctx;
    const posted = await as(B, "POST", `/api/threads/${B.ids.thread}/messages`, {
      body: "hello",
      authorId: "someone-else",
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().message.authorId).toBe(`user:${B.ownerUserId}`);
    const decided = await as(B, "POST", `/api/approvals/${B.ids.approval}/decide`, {
      decision: "deny",
      authorId: "forged",
    });
    expect(decided.statusCode).toBe(200);
    expect(ctx.approvals.mustGet(B.ids.approval as never).decidedBy).toBe(
      `human:user:${B.ownerUserId}`,
    );
  });
});
