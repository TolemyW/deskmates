// T1: service principals (ADR-0022 amendment 2). A tenant-scoped machine identity for external
// agent clients: an Admin creates it and sees its token once; the token works as
// `Authorization: Bearer` on the operator listener only, as a Member of its one tenant, and is
// re-checked on every request. Two tenants, A and B, each seeded with one row of every kind.

import { createHash } from "node:crypto";
import { CSRF_HEADER, type RunId, type WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
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

let sandbox: ReturnType<typeof buildGateway>;
let operator: FastifyInstance;
let A: TenantFixture;
let B: TenantFixture;

beforeAll(async () => {
  sandbox = buildGateway(
    testConfig({
      secretsKey: Buffer.alloc(32, 7).toString("base64"),
      auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
    }),
    new FakeProvider(),
    { startCron: false },
  );
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
  A = await seedTenant(sandbox.deskmates.ctx, "A");
  B = await seedTenant(sandbox.deskmates.ctx, "B");
});
afterAll(async () => {
  await operator.close();
  await sandbox.close();
});

function asSession(
  who: { token: string; csrf: string },
  method: string,
  url: string,
  payload?: unknown,
) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: {
      cookie: `${SESSION}=${who.token}`,
      host: HOST,
      origin: `http://${HOST}`,
      [CSRF_HEADER]: who.csrf,
    },
  };
  if (payload !== undefined) options.payload = payload;
  // Arbitrary JSON bodies: the inject typing wants a narrower payload type than tests need.
  return operator.inject(options as unknown as InjectOptions);
}

function asBearer(
  token: string,
  method: string,
  url: string,
  payload?: unknown,
  extra: Record<string, string> = {},
  app: { inject: FastifyInstance["inject"] } = operator,
) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...extra },
  };
  if (payload !== undefined) options.payload = payload;
  // Arbitrary JSON bodies, as above.
  return app.inject(options as unknown as InjectOptions);
}

/**
 * Service principals are the root's to manage (ADR-0022 amendment 6 W2), and the root acts in
 * the Default Tenant; these fixtures create a tenant's principal in its store, as the root's
 * maintenance does, and test what the principal may then do.
 */
async function createPrincipal(
  owner: TenantFixture,
  body: Record<string, unknown> = {},
): Promise<{ id: string; token: string }> {
  const { record, token } = sandbox.deskmates.ctx.auth.servicePrincipals.create(
    owner.tenantId,
    { name: "release-agent", ...body } as Parameters<
      typeof sandbox.deskmates.ctx.auth.servicePrincipals.create
    >[1],
    `user:${owner.ownerUserId}`,
    "admin",
  );
  return { id: record.id, token };
}

async function memberSession(tenant: TenantFixture, name: string) {
  const ctx = sandbox.deskmates.ctx;
  await ctx.auth.createUser({
    loginName: name,
    displayName: name,
    password: FIXTURE_PASSWORD,
    role: "member",
    tenantId: tenant.tenantId,
  });
  const { token } = await ctx.auth.login(name, FIXTURE_PASSWORD, name);
  const { csrfTokenFor } = await import("../auth/tokens.js");
  return { token, csrf: csrfTokenFor(token) };
}

type TenantPolicy = Extract<RoutePolicy, { access: "tenant" }>;

function requestFor(key: string, policy: TenantPolicy, owner: TenantFixture) {
  const [method, path] = key.split(" ") as [string, string];
  const params: Record<string, string> = {};
  for (const [name, kind] of Object.entries(policy.params ?? {})) params[name] = owner.ids[kind];
  let url = path.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
    encodeURIComponent(
      params[name] ?? (name === "id" && path.includes("/tasks/") ? owner.ids.task : `none-${name}`),
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
  return { method, url, body: ["GET", "DELETE"].includes(method) ? undefined : body };
}

describe("creation and storage", () => {
  it("the root creates a principal, sees its token once, and only the SHA-256 is stored", async () => {
    // The operator credential is the root of the Default Tenant (ADR-0022 amendment 6 W2).
    const created = await asBearer(TEST_OPERATOR_TOKEN, "POST", "/api/service-principals", {
      name: "ci-agent",
      dailyUsdCap: 2.5,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { servicePrincipal, token } = created.json();
    expect(token).toMatch(/^deskmates-sp\./);
    expect(servicePrincipal).toMatchObject({
      name: "ci-agent",
      // The root's principal is an Admin, never an Owner (ADR-0022 amendment 1 A10).
      role: "admin",
      status: "active",
      dailyUsdCap: 2.5,
    });
    const row = sandbox.deskmates.ctx.db
      .prepare("SELECT token_hash FROM service_principals WHERE id = ?")
      .get(servicePrincipal.id) as { token_hash: string };
    expect(row.token_hash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(snapshotDatabase(sandbox.deskmates.ctx)).not.toContain(token);
    const listed = await asBearer(TEST_OPERATOR_TOKEN, "GET", "/api/service-principals");
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain(servicePrincipal.id);
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain(row.token_hash);
  });

  it("only the root manages principals: an Owner or a Member is refused with no side effect", async () => {
    const member = await memberSession(A, "sp-member-a");
    const before = snapshotDatabase(sandbox.deskmates.ctx);
    for (const who of [member, A, B]) {
      const created = await asSession(who, "POST", "/api/service-principals", { name: "x" });
      expect(created.statusCode).toBe(403);
      expect(created.json().details?.reason).toBe("root_only");
      expect((await asSession(who, "GET", "/api/service-principals")).statusCode).toBe(403);
    }
    for (const action of ["disable", "rotate"])
      expect(
        (await asSession(B, "POST", `/api/service-principals/${A.ids.servicePrincipal}/${action}`))
          .statusCode,
      ).toBe(403);
    expect(snapshotDatabase(sandbox.deskmates.ctx)).toBe(before);
  });

  it("refuses an invalid name or budget", async () => {
    for (const body of [
      { name: "" },
      { name: "x", dailyUsdCap: -1 },
      { name: "x", dailyUsdCap: "5" },
    ]) {
      const response = await asBearer(TEST_OPERATOR_TOKEN, "POST", "/api/service-principals", body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the bearer credential", () => {
  it("acts as a Member of its own tenant only: B's ids are the uniform 404, with no side effect", async () => {
    const { token } = await createPrincipal(A, { name: "walker", role: "member" });
    const own = await asBearer(token, "GET", "/api/workspaces");
    expect(own.statusCode).toBe(200);
    expect(own.json().workspaces.map((w: { id: string }) => w.id)).toEqual([A.ids.workspace]);
    expect((await asBearer(token, "GET", `/api/threads/${A.ids.thread}`)).statusCode).toBe(200);

    const routes = Object.entries(ROUTE_POLICY).filter(
      (entry): entry is [string, TenantPolicy] =>
        entry[1].access === "tenant" &&
        Object.keys({ ...entry[1].params, ...entry[1].query, ...entry[1].body }).length > 0 &&
        !(entry[1].scopedList && !entry[1].params && !entry[1].body),
    );
    expect(routes.length).toBeGreaterThan(60);
    const before = snapshotDatabase(sandbox.deskmates.ctx);
    for (const [key, policy] of routes) {
      const request = requestFor(key, policy, B);
      const response = await asBearer(token, request.method, request.url, request.body);
      // The role is checked before any identifier, so an Admin route is 403 for every id alike.
      const expected = policy.role === "member" || policy.role === "guest" ? 404 : 403;
      expect(response.statusCode, `${key} with B's ids`).toBe(expected);
      if (expected === 404) expect(response.json(), key).toEqual(DENIAL);
    }
    for (const path of ["/api/threads", "/api/runs", "/api/approvals", "/api/costs", "/api/bots"]) {
      const listed = await asBearer(token, "GET", path);
      expect(listed.statusCode, path).toBe(200);
      expect(listed.body, path).not.toContain(B.sentinel);
    }
    expect(snapshotDatabase(sandbox.deskmates.ctx)).toBe(before);
  });

  it("cannot call Admin or platform routes", async () => {
    const { token } = await createPrincipal(A, { name: "climber", role: "member" });
    const before = snapshotDatabase(sandbox.deskmates.ctx);
    for (const [method, url, body] of [
      ["POST", "/api/service-principals", { name: "self-made" }],
      ["GET", "/api/service-principals"],
      ["POST", `/api/service-principals/${A.ids.servicePrincipal}/rotate`],
      ["GET", "/api/members"],
      [
        "POST",
        "/api/invitations",
        { role: "member", target: { kind: "local_new", loginName: "z" } },
      ],
      ["PATCH", `/api/workspaces/${A.ids.workspace}`, { egressAllowlist: ["*"] }],
      ["POST", `/api/bots/${A.ids.bot}/approval-rules`, { decision: "allow_always", matcher: {} }],
      ["GET", "/api/runtime"],
      ["PUT", "/api/prices", { prices: [] }],
      ["POST", "/api/integrations/providers", { service: "github" }],
      ["POST", "/api/knowledge/versions/cleanup"],
    ] as Array<[string, string, unknown?]>) {
      expect((await asBearer(token, method, url, body)).statusCode, `${method} ${url}`).toBe(403);
    }
    expect(snapshotDatabase(sandbox.deskmates.ctx)).toBe(before);
  });

  it("cannot select another tenant, and is never accepted in a URL", async () => {
    const { token } = await createPrincipal(A, { name: "selector" });
    const foreign = await asBearer(token, "GET", "/api/workspaces", undefined, {
      "x-deskmates-tenant": B.tenantId,
    });
    expect(foreign.statusCode).toBe(401);
    const own = await asBearer(token, "GET", "/api/workspaces", undefined, {
      "x-deskmates-tenant": A.tenantId,
    });
    expect(own.statusCode).toBe(200);
    const inUrl = await operator.inject({
      method: "GET",
      url: `/api/workspaces?token=${encodeURIComponent(token)}`,
    });
    expect(inUrl.statusCode).toBe(401);
  });

  it("never works on the sandbox listener or the model proxy", async () => {
    const { token } = await createPrincipal(A, { name: "sandboxed" });
    const internal = await asBearer(
      token,
      "POST",
      `/internal/runs/${A.ids.run}/events`,
      { events: [] },
      {},
      sandbox,
    );
    expect(internal.statusCode).toBe(401);
    const approvals = await asBearer(
      token,
      "GET",
      `/internal/runs/${A.ids.run}/approvals/${A.ids.approval}`,
      undefined,
      {},
      sandbox,
    );
    expect(approvals.statusCode).toBe(401);
    const model = await asBearer(
      token,
      "POST",
      "/v1/messages",
      { model: "x", messages: [] },
      {},
      sandbox,
    );
    expect(model.statusCode).toBe(401);
    // And the operator routes are not served on the sandbox listener at all.
    expect(
      (await asBearer(token, "GET", "/api/workspaces", undefined, {}, sandbox)).statusCode,
    ).toBe(404);
  });

  it("a run token and the operator credential are not service principals", async () => {
    const runToken = sandbox.deskmates.ctx.tokens.issue(A.ids.run as RunId).token;
    expect((await asBearer(runToken, "GET", "/api/workspaces")).statusCode).toBe(401);
    expect(
      (await asBearer(`deskmates-sp.${"x".repeat(43)}`, "GET", "/api/workspaces")).statusCode,
    ).toBe(401);
    expect((await asBearer(TEST_OPERATOR_TOKEN, "GET", "/api/runtime")).statusCode).toBe(200);
  });
});

describe("disable and rotate", () => {
  it("a disabled principal's token stops working on the next request and its streams close", async () => {
    const { id, token } = await createPrincipal(A, { name: "to-disable" });
    expect((await asBearer(token, "GET", "/api/workspaces")).statusCode).toBe(200);
    const auth = sandbox.deskmates.ctx.auth;
    const resolved = auth.resolveServiceToken(token);
    expect(resolved).toBeDefined();
    let closed = 0;
    auth.live.register(resolved?.liveKey ?? "missing", () => {
      closed += 1;
    });
    // The root's maintenance disables it (ADR-0022 amendment 6 W2).
    expect(auth.disableServicePrincipal(A.tenantId, id, "test").status).toBe("disabled");
    expect(closed).toBe(1);
    expect((await asBearer(token, "GET", "/api/workspaces")).statusCode).toBe(401);
    // Disabling is final: a disabled principal cannot be given a new token.
    expect(() => auth.rotateServicePrincipal(A.tenantId, id, "test")).toThrow();
  });

  it("rotation ends the old token at once and the new one works", async () => {
    const { id, token } = await createPrincipal(A, { name: "to-rotate" });
    const auth = sandbox.deskmates.ctx.auth;
    const before = auth.resolveServiceToken(token);
    let closed = 0;
    auth.live.register(before?.liveKey ?? "missing", () => {
      closed += 1;
    });
    const next = auth.rotateServicePrincipal(A.tenantId, id, "test").token;
    expect(next).not.toBe(token);
    expect(closed).toBe(1);
    expect((await asBearer(token, "GET", "/api/workspaces")).statusCode).toBe(401);
    expect((await asBearer(next, "GET", "/api/workspaces")).statusCode).toBe(200);
    // A sweep re-checks a stream opened with the old token against the stored hash.
    expect(auth.sessionStillAuthorized(before?.liveKey ?? "missing")).toBe(false);
    expect(auth.sessionStillAuthorized(auth.resolveServiceToken(next)?.liveKey ?? "x")).toBe(true);
  });

  it("a suspended tenant's principals stop working", async () => {
    const C = await seedTenant(sandbox.deskmates.ctx, "C");
    const { token } = await createPrincipal(C, { name: "suspended" });
    expect((await asBearer(token, "GET", "/api/workspaces")).statusCode).toBe(200);
    sandbox.deskmates.ctx.auth.users.setTenantStatus(C.tenantId, "suspended");
    expect((await asBearer(token, "GET", "/api/workspaces")).statusCode).toBe(401);
  });
});

describe("tenant roles (ADR-0022 amendment 1 A10)", () => {
  async function adminSession(tenant: TenantFixture, name: string) {
    const ctx = sandbox.deskmates.ctx;
    await ctx.auth.createUser({
      loginName: name,
      displayName: name,
      password: FIXTURE_PASSWORD,
      role: "admin",
      tenantId: tenant.tenantId,
    });
    const { token } = await ctx.auth.login(name, FIXTURE_PASSWORD, name);
    const { csrfTokenFor } = await import("../auth/tokens.js");
    return { token, csrf: csrfTokenFor(token) };
  }

  it("takes its creator's role (the root's is admin), may be lowered to member, never raised to owner", async () => {
    const root = (method: string, url: string, body?: unknown) =>
      asBearer(TEST_OPERATOR_TOKEN, method, url, body);
    const byRoot = await root("POST", "/api/service-principals", { name: "by-root" });
    expect(byRoot.statusCode).toBe(201);
    expect(byRoot.json().servicePrincipal.role).toBe("admin");
    const lowered = await root("POST", "/api/service-principals", {
      name: "lowered",
      role: "member",
    });
    expect(lowered.statusCode).toBe(201);
    expect(lowered.json().servicePrincipal.role).toBe("member");
    const before = snapshotDatabase(sandbox.deskmates.ctx);
    for (const role of ["owner", "superuser", 7])
      expect(
        (await root("POST", "/api/service-principals", { name: "x", role })).statusCode,
        String(role),
      ).toBe(400);
    expect(snapshotDatabase(sandbox.deskmates.ctx)).toBe(before);
    // Rotation keeps the role, and the list shows it.
    const rotated = await root(
      "POST",
      `/api/service-principals/${lowered.json().servicePrincipal.id}/rotate`,
    );
    expect(rotated.json().servicePrincipal.role).toBe("member");
    const listed = (await root("GET", "/api/service-principals")).json()
      .servicePrincipals as Array<{ id: string; role: string }>;
    expect(listed.find((p) => p.id === lowered.json().servicePrincipal.id)?.role).toBe("member");
    expect(listed.find((p) => p.id === byRoot.json().servicePrincipal.id)?.role).toBe("admin");
  });

  it("a member principal is held to the Member rules, side chats included", async () => {
    const ctx = sandbox.deskmates.ctx;
    const { id, token } = await createPrincipal(A, {
      name: "member-agent",
      role: "member",
    });
    const workspaceId = A.ids.workspace as WorkspaceId;
    const helper = ctx.bots.create({ name: "spsidehelper", role: "test", workspaceId });
    ctx.bots.create({ name: "spoutsider", role: "test", workspaceId });
    const group = ctx.threads.create({ workspaceId, botIds: [A.ids.bot as never, helper.id] }).id;
    const before = snapshotDatabase(ctx);
    // Posting in the group and the composite submit are a Member's since amendment 6 W5; adding
    // a bot to it by a mention, members, tasks and group chats stay an Admin's.
    for (const [method, url, body] of [
      ["POST", `/api/threads/${group}/messages`, { body: "@spoutsider hello" }],
      ["POST", `/api/threads/${group}/members`, { botIds: [helper.id] }],
      ["POST", `/api/workspaces/${workspaceId}/tasks`, { title: "t" }],
      ["POST", "/api/threads", { workspaceId, botIds: [A.ids.bot, helper.id] }],
      ["POST", `/api/approvals/${A.ids.approval}/decide`, { decision: "allow_always" }],
    ] as Array<[string, string, unknown]>) {
      expect((await asBearer(token, method, url, body)).statusCode, `${method} ${url}`).toBe(403);
    }
    expect(snapshotDatabase(ctx)).toBe(before);
    // Its own side chat, keyed on service:<id>.
    const side = await asBearer(token, "POST", "/api/threads", {
      workspaceId,
      botIds: [helper.id],
    });
    expect(side.statusCode, side.body).toBe(201);
    expect(side.json().thread.sideChatActor).toBe(`service:${id}`);
    const posted = await asBearer(token, "POST", `/api/threads/${side.json().thread.id}/messages`, {
      body: "a question",
    });
    expect(posted.statusCode, posted.body).toBe(201);
  });

  it("an admin principal passes the Admin routes but never platform maintenance", async () => {
    const ctx = sandbox.deskmates.ctx;
    const { token } = await createPrincipal(A, { name: "admin-agent" });
    const workspaceId = A.ids.workspace as WorkspaceId;
    const helper = ctx.bots.create({ name: "spadminhelper", role: "test", workspaceId });
    const group = ctx.threads.create({ workspaceId, botIds: [A.ids.bot as never, helper.id] }).id;
    expect(
      (await asBearer(token, "POST", `/api/threads/${group}/messages`, { body: "hi" })).statusCode,
    ).toBe(201);
    expect(
      (await asBearer(token, "POST", `/api/workspaces/${workspaceId}/tasks`, { title: "t" }))
        .statusCode,
    ).toBe(201);
    for (const [method, url, body] of [
      ["GET", "/api/runtime"],
      ["PUT", "/api/prices", { prices: [] }],
      ["POST", "/api/knowledge/versions/cleanup"],
    ] as Array<[string, string, unknown?]>)
      expect((await asBearer(token, method, url, body)).statusCode, url).toBe(403);
  });
});

describe("people routes are for people (PR #37 routes under ADR-0022 amendment 1)", () => {
  const peopleRoutes = (): Array<[string, string, unknown?]> => [
    ["GET", "/api/members"],
    ["PATCH", `/api/members/${A.ownerUserId}`, { status: "removed" }],
    ["GET", "/api/invitations"],
    ["POST", "/api/invitations", { role: "member", target: { kind: "local_signup" } }],
    ["DELETE", "/api/invitations/inv_none"],
    ["POST", "/api/accounts", { loginName: "made-by-agent", displayName: "x", role: "member" }],
  ];

  it("a member principal is refused every account, invitation and member route, and has no profile", async () => {
    const { token } = await createPrincipal(A, { name: "people-member", role: "member" });
    const before = snapshotDatabase(sandbox.deskmates.ctx);
    for (const [method, url, body] of peopleRoutes())
      expect((await asBearer(token, method, url, body)).statusCode, `${method} ${url}`).toBe(403);
    for (const [method, url, body] of [
      ["PATCH", "/auth/profile", { displayName: "Agent" }],
      ["DELETE", "/auth/avatar"],
      ["GET", "/auth/avatar"],
    ] as Array<[string, string, unknown?]>) {
      const response = await asBearer(token, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(400);
      expect(response.json().details.reason, url).toBe("no_user");
    }
    expect(snapshotDatabase(sandbox.deskmates.ctx)).toBe(before);
  });

  it("an admin principal is refused them too: people are managed by people", async () => {
    const { token } = await createPrincipal(A, { name: "people-admin" });
    const before = snapshotDatabase(sandbox.deskmates.ctx);
    for (const [method, url, body] of peopleRoutes()) {
      const response = await asBearer(token, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().details.reason, `${method} ${url}`).toBe("people_only");
    }
    expect(snapshotDatabase(sandbox.deskmates.ctx)).toBe(before);
    // An Admin person still manages people.
    expect((await asSession(A, "GET", "/api/members")).statusCode).toBe(200);
  });

  it("a principal cannot accept an invitation", async () => {
    const { token } = await createPrincipal(A, { name: "people-acceptor" });
    const issued = await asSession(A, "POST", "/api/invitations", {
      role: "member",
      target: { kind: "local_new", loginName: "agent-made" },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const before = snapshotDatabase(sandbox.deskmates.ctx);
    const accepted = await asBearer(token, "POST", "/auth/invitations/accept", {
      token: issued.json().token,
      displayName: "Agent",
      password: FIXTURE_PASSWORD,
    });
    expect(accepted.statusCode).toBeGreaterThanOrEqual(400);
    expect(accepted.statusCode).toBeLessThan(500);
    expect(snapshotDatabase(sandbox.deskmates.ctx)).toBe(before);
  });
});

describe("budget and attribution", () => {
  /** A new bot and one-member thread in A's workspace, so each case starts with an idle lane. */
  let botCount = 0;
  function freshThread(): string {
    const ctx = sandbox.deskmates.ctx;
    botCount += 1;
    const workspaceId = A.ids.workspace as WorkspaceId;
    const bot = ctx.bots.create({ name: `budgetbot${botCount}`, role: "test", workspaceId });
    return ctx.threads.create({ workspaceId, botIds: [bot.id] }).id;
  }

  it("attributes its messages to service:<id>, whatever the body says", async () => {
    const { id, token } = await createPrincipal(A, { name: "author" });
    const url = `/api/threads/${freshThread()}/messages`;
    const posted = await asBearer(token, "POST", url, {
      body: "deploy please",
      authorId: "someone-else",
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json().message.authorId).toBe(`service:${id}`);
    // People and the operator credential keep their labels.
    const person = await asSession(A, "POST", url, { body: "hello", authorId: "forged" });
    expect(person.json().message.authorId).toBe(`user:${A.ownerUserId}`);
    const ctx = sandbox.deskmates.ctx;
    const workspace = ctx.workspaces.create({ name: "legacy", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ name: "legacybot", role: "test", workspaceId: workspace.id });
    const legacyUrl = `/api/threads/${ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id] }).id}/messages`;
    const legacy = await asBearer(TEST_OPERATOR_TOKEN, "POST", legacyUrl, {
      body: "from the adapter",
      authorId: "whatsapp:123",
    });
    expect(legacy.statusCode, legacy.body).toBe(201);
    expect(legacy.json().message.authorId).toBe("whatsapp:123");
    const unnamed = await asBearer(TEST_OPERATOR_TOKEN, "POST", legacyUrl, { body: "no author" });
    expect(unnamed.json().message.authorId).toBe("web");
  });

  it("does not limit how many of its runs are in flight (amendment 5)", async () => {
    const { token } = await createPrincipal(A, { name: "busy" });
    // A thread each: a message to a thread whose run is still queued joins that run.
    for (const body of ["one", "two", "three"]) {
      const url = `/api/threads/${freshThread()}/messages`;
      const posted = await asBearer(token, "POST", url, { body });
      expect(posted.statusCode, posted.body).toBe(201);
      const [run] = posted.json().runs as Array<{ id: string; triggerRef: string }>;
      expect(run?.triggerRef).toBe(posted.json().message.id);
    }
    const row = sandbox.deskmates.ctx.db
      .prepare("SELECT * FROM service_principals WHERE name = 'busy'")
      .get() as Record<string, unknown>;
    expect(row).not.toHaveProperty("max_concurrent_runs");
  });

  it("refuses a message with 429 once today's known cost of its runs reaches the cap", async () => {
    const ctx = sandbox.deskmates.ctx;
    const { token } = await createPrincipal(A, {
      name: "spender",
      dailyUsdCap: 1,
    });
    const url = `/api/threads/${freshThread()}/messages`;
    const first = await asBearer(token, "POST", url, { body: "work" });
    expect(first.statusCode).toBe(201);
    const runId = first.json().runs[0].id as RunId;
    const usage = ctx.db.prepare(
      "INSERT INTO run_usage (run_id, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 1, 1, ?)",
    );
    usage.run(runId, "priced-a", 0.4);
    // Unpriced usage is unknown, not zero, and does not count toward the cap.
    usage.run(runId, "unpriced", null);
    expect((await asBearer(token, "POST", url, { body: "more" })).statusCode).toBe(201);
    usage.run(runId, "priced-b", 0.6);
    const before = snapshotDatabase(ctx);
    const refused = await asBearer(token, "POST", url, { body: "even more" });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      code: "budget_exceeded",
      details: { limit: "daily_usd", spentUsd: 1, capUsd: 1 },
    });
    expect(snapshotDatabase(ctx)).toBe(before);
    // A person in the same tenant is not limited by the principal's budget.
    expect((await asSession(A, "POST", url, { body: "a person" })).statusCode).toBe(201);
  });
});
