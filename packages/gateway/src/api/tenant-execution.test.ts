// T1: ADR-0022 P3 execution boundary (test plan EVT-01, EVT-02, JOB-01, LIMIT-01, INT-01, INT-02).
// Two tenants on one Gateway over real HTTP. Every refusal is paired with the owning tenant's
// same operation succeeding, so a broken feature cannot pass as isolation.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotDefinition,
  BotId,
  ConnectorRegistration,
  RunEnded,
  ScreenAccess,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { CSRF_HEADER, TENANT_HEADER } from "@deskmates/contracts";
import { FakeConnector } from "@deskmates/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { csrfTokenFor } from "../auth/tokens.js";
import { buildContext } from "../context.js";
import { openDatabase } from "../db/open.js";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import {
  CONNECTOR_CREDENTIAL,
  CONNECTOR_URL,
  TEST_SECRETS_KEY,
} from "../test-support/connector-fixture.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { startFakeVnc } from "../test-support/fake-vnc.js";
import { type Harness, startHarness, testConfig, waitFor } from "../test-support/harness.js";
import { integrationFixture } from "../test-support/integration-fixture.js";
import { createOwner } from "../test-support/owner.js";
import { type TenantFixture, seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Sidecar starts the fake provider saw, in order. */
let starts: Array<{ runId: string; workspaceId: string }> = [];

async function harness(overrides: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness({ auth: FAST_AUTH, secretsKey: TEST_SECRETS_KEY, ...overrides });
  cleanups.push(() => h.close());
  starts = [];
  // Every run this file starts ends at once unless a test holds it.
  h.provider.onRun(async (req, gw) => {
    starts.push({ runId: req.runId, workspaceId: req.workspaceId });
    const ended: RunEnded = {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      usage: [],
    };
    await gw.post("ended", ended);
  });
  return h;
}

interface Stream {
  text(): string;
  ended: Promise<void>;
  close(): void;
}

/** An SSE stream opened with a session cookie, optionally in a selected tenant. */
async function openStream(
  h: Harness,
  token: string,
  options: { tenantId?: string; query?: string } = {},
): Promise<{ status: number; stream?: Stream }> {
  const controller = new AbortController();
  const response = await fetch(`${h.baseUrl}/api/events${options.query ?? ""}`, {
    headers: {
      cookie: `${SESSION}=${token}`,
      ...(options.tenantId ? { [TENANT_HEADER]: options.tenantId } : {}),
    },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    await response.text();
    return { status: response.status };
  }
  let buffer = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const ended = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString("utf8");
      }
    } catch {
      // Aborted or destroyed: the stream has ended.
    }
  })();
  const stream = { text: () => buffer, ended, close: () => controller.abort() };
  cleanups.push(() => stream.close());
  await waitFor(() => buffer.includes(": connected"), 2000, "stream connected");
  return { status: 200, stream };
}

/** Let the runs `seedTenant` queued start and end, so later assertions see only new starts. */
async function drainSeeded(h: Harness, ...tenants: TenantFixture[]): Promise<void> {
  h.app.deskmates.scheduler.tick();
  for (const t of tenants)
    await waitFor(
      () =>
        starts.some((s) => s.runId === t.ids.run) &&
        h.app.deskmates.scheduler.tenantActiveAttempts(t.tenantId) === 0,
      3000,
      `${t.sentinel} seeded run drained`,
    );
}

/** Publish one event of every kind owned by `t`, as the stores do. */
function publishEverything(h: Harness, t: TenantFixture): void {
  const ctx = h.app.deskmates.ctx;
  const bus = ctx.bus;
  const run = ctx.runs.mustGet(t.ids.run as never);
  const threadId = t.ids.thread as ThreadId;
  const workspaceId = t.ids.workspace as WorkspaceId;
  bus.publish({ type: "thread_members", threadId });
  bus.publish({ type: "run_status", threadId, run });
  // A run event without a threadId must still resolve through its run.
  bus.publish({
    type: "run_event",
    event: { runId: run.id, seq: 1, kind: "log", payload: { mark: t.sentinel }, at: run.createdAt },
  } as never);
  bus.publish({ type: "approval", approval: ctx.approvals.mustGet(t.ids.approval as never) });
  bus.publish({ type: "workspace_lock", workspaceId, browserLock: null });
  bus.publish({ type: "workspace", workspaceId, workspace: ctx.workspaces.mustGet(workspaceId) });
  bus.publish({
    type: "cost_alert",
    alert: ctx.costAlerts.mustGetAlert(t.tenantId, t.ids.costAlert),
  });
}

describe("EVT-01: a stream carries only its own tenant's events", () => {
  it("delivers every event kind to the owner and none to the other tenant", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const a = (await openStream(h, A.token)).stream as Stream;
    const b = (await openStream(h, B.token)).stream as Stream;
    publishEverything(h, A);
    publishEverything(h, B);
    // An event no row owns is dropped, never broadcast.
    ctx.bus.publish({ type: "thread_members", threadId: "thr_nobody" as ThreadId });
    const kinds = [
      "thread_members",
      "run_status",
      "run_event",
      "approval",
      "workspace_lock",
      "workspace",
      "cost_alert",
    ];
    for (const [stream, own] of [
      [a, A],
      [b, B],
    ] as const) {
      await waitFor(
        () => kinds.every((kind) => stream.text().includes(`event: ${kind}`)),
        3000,
        `${own.sentinel} events`,
      );
    }
    for (const [stream, other] of [
      [a, B],
      [b, A],
    ] as const) {
      const text = stream.text();
      for (const id of Object.values(other.ids)) expect(text).not.toContain(id);
      expect(text).not.toContain(other.sentinel);
      expect(text).not.toContain("thr_nobody");
      // Exactly one of each kind arrived: the owner's.
      for (const kind of kinds) expect(text.split(`event: ${kind}\n`).length - 1).toBe(1);
    }
  });

  it("a thread filter naming another tenant's thread is the uniform 404", async () => {
    const h = await harness();
    const A = await seedTenant(h.app.deskmates.ctx, "A");
    const B = await seedTenant(h.app.deskmates.ctx, "B");
    expect((await openStream(h, A.token, { query: `?threadId=${B.ids.thread}` })).status).toBe(404);
    expect((await openStream(h, A.token, { query: `?threadId=${A.ids.thread}` })).status).toBe(200);
  });

  it("losing one membership closes that tenant's stream and keeps the other tenant's", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const user = await ctx.auth.createUser({
      loginName: "both",
      displayName: "Both",
      password: TEST_PASSWORD,
      role: "admin",
      tenantId: A.tenantId,
    });
    ctx.auth.users.addMembership(B.tenantId, user.id, "admin");
    const { token, session } = await ctx.auth.login("both", TEST_PASSWORD, "test");
    const inA = (await openStream(h, token, { tenantId: A.tenantId })).stream as Stream;
    const inB = (await openStream(h, token, { tenantId: B.tenantId })).stream as Stream;
    expect(ctx.auth.live.count(session.id)).toBe(2);
    ctx.auth.users.updateMembership(A.tenantId, user.id, { status: "removed" });
    expect(ctx.auth.live.sweep()).toBe(1);
    await inA.ended;
    expect(ctx.auth.live.count(session.id)).toBe(1);
    publishEverything(h, B);
    await waitFor(() => inB.text().includes("event: cost_alert"), 3000, "B stream still live");
    // The selector for the removed tenant is now refused outright.
    expect((await openStream(h, token, { tenantId: A.tenantId })).status).toBe(401);
  });
});

describe("EVT-02: only a watcher of the run's tenant keeps an approval live", () => {
  it("counts presence per tenant, for any member of it", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    await ctx.auth.createUser({
      loginName: "amember",
      displayName: "A member",
      password: TEST_PASSWORD,
      role: "member",
      tenantId: A.tenantId,
    });
    const member = await ctx.auth.login("amember", TEST_PASSWORD, "test");
    expect(ctx.presence.humanOnline(A.tenantId)).toBe(false);
    // B's Owner watching keeps nothing of A live.
    const bOwner = (await openStream(h, B.token)).stream as Stream;
    expect(ctx.presence.humanOnline(B.tenantId)).toBe(true);
    expect(ctx.presence.humanOnline(A.tenantId)).toBe(false);
    // Every member may decide A's approvals, so A's Member watching counts.
    const aMember = (await openStream(h, member.token)).stream as Stream;
    expect(ctx.presence.humanOnline(A.tenantId)).toBe(true);
    aMember.close();
    await aMember.ended;
    await waitFor(() => !ctx.presence.humanOnline(A.tenantId), 2000, "A presence closed");
    expect(ctx.presence.humanOnline(B.tenantId)).toBe(true);
    bOwner.close();
  });
});

describe("JOB-01 / LIMIT-01: the scheduler keeps tenants apart", () => {
  it("never starts a suspended tenant's run, whatever its payload says, and resumes it after", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    await drainSeeded(h, A, B);
    ctx.auth.users.setTenantStatus(B.tenantId, "suspended");
    const spoofed = ctx.runs.create({
      botId: B.ids.bot as never,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "spoof",
      triggerPayload: { tenantId: A.tenantId, workspaceId: A.ids.workspace },
      config: ctx.runConfig(),
    });
    const fine = ctx.runs.create({
      botId: A.ids.bot as never,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "fine",
      triggerPayload: {},
      config: ctx.runConfig(),
    });
    const startedBefore = starts.length;
    h.app.deskmates.scheduler.tick();
    await waitFor(() => ctx.runs.mustGet(fine.id).status === "succeeded", 3000, "A runs");
    expect(ctx.runs.mustGet(spoofed.id).status).toBe("queued");
    const whileSuspended = starts.slice(startedBefore);
    expect(whileSuspended.map((s) => s.runId)).toContain(fine.id);
    expect(whileSuspended.filter((s) => s.workspaceId === B.ids.workspace)).toEqual([]);
    const log = ctx.events.list(spoofed.id).map((e) => e.payload);
    expect(log).toContainEqual(
      expect.objectContaining({ source: "scheduler", waitReason: "tenant_suspended" }),
    );
    ctx.auth.users.setTenantStatus(B.tenantId, "active");
    h.app.deskmates.scheduler.tick();
    await waitFor(() => ctx.runs.mustGet(spoofed.id).status === "succeeded", 3000, "B resumed");
    const started = starts.find((s) => s.runId === spoofed.id);
    expect(started?.workspaceId).toBe(B.ids.workspace);
  });

  it("a held run caps nothing: the same tenant's and another tenant's runs still start (amendment 5)", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    await drainSeeded(h, A, B);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holdA = new Set<string>();
    h.provider.onRun(async (req, gw) => {
      const ended: RunEnded = {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
      };
      await gw.post("ended", ended);
      if (holdA.has(req.runId)) await held;
    });
    const second = ctx.workspaces.create({
      tenantId: A.tenantId,
      name: "A second",
      sandboxProvider: "docker",
    });
    const secondBot = ctx.bots.create({ name: "asecond", role: "r", workspaceId: second.id });
    const run = (botId: string) =>
      ctx.runs.create({
        botId: botId as never,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: `limit-${botId}`,
        triggerPayload: {},
        config: ctx.runConfig(),
      });
    try {
      const first = run(A.ids.bot);
      holdA.add(first.id);
      h.app.deskmates.scheduler.tick();
      await waitFor(() => ctx.runs.mustGet(first.id).status === "succeeded", 3000, "A first");
      expect(h.app.deskmates.scheduler.tenantActiveAttempts(A.tenantId)).toBe(1);
      const sameTenant = run(secondBot.id);
      const other = run(B.ids.bot);
      h.app.deskmates.scheduler.tick();
      await waitFor(() => ctx.runs.mustGet(other.id).status === "succeeded", 3000, "B starts");
      await waitFor(
        () => ctx.runs.mustGet(sameTenant.id).status === "succeeded",
        3000,
        "A's second workspace starts while its first run is held",
      );
      // Its process exits after `run_ended` lands; the held one is still A's only attempt then.
      await waitFor(
        () => h.app.deskmates.scheduler.tenantActiveAttempts(A.tenantId) === 1,
        3000,
        "A's second process exits",
      );
      expect(ctx.events.list(sameTenant.id).map((e) => e.payload)).not.toContainEqual(
        expect.objectContaining({ source: "scheduler" }),
      );
    } finally {
      release();
    }
  });
});

describe("INT-01: an OAuth grant completes only in the session that started it", () => {
  it("refuses a swapped callback, a signed-out session and a demoted Admin", async () => {
    const f = await integrationFixture();
    cleanups.push(() => f.close());
    await f.adopt("slack");
    await f.h.api("PUT", "/api/integrations/providers/slack/oauth-app", {
      clientId: "slack-client",
      clientSecret: "slack-secret",
      requestedScopes: ["chat:write"],
    });
    const ctx = f.h.app.deskmates.ctx;
    // Not the protected root, which is never demoted: an Owner of the workspaces that exist now.
    const owner = await createOwner(
      ctx.auth,
      { loginName: "owner", displayName: "Owner", password: TEST_PASSWORD },
      { root: false },
    );
    const signIn = async () => {
      const jar = new BrowserJar(f.h.baseUrl);
      expect((await jar.signIn("owner")).status).toBe(200);
      return jar;
    };
    const start = async (jar: BrowserJar, name: string) => {
      const res = await jar.json<{ authorizationUrl: string }>(
        "POST",
        `/api/integrations/workspaces/${f.a.workspace.id}/connections/oauth/start`,
        { body: { service: "slack", connectionName: name } },
      );
      expect(res.status).toBe(200);
      return new URL(res.json.authorizationUrl).searchParams.get("state") as string;
    };
    const callback = (jar: BrowserJar | undefined, state: string) =>
      (jar ?? new BrowserJar(f.h.baseUrl)).fetch(
        "GET",
        `/api/integrations/oauth/callback?code=c&state=${state}`,
      );

    const jar = await signIn();
    // Another browser holding the callback URL cannot finish it, and the state is then spent.
    const swapped = await start(jar, "swapped");
    expect((await callback(undefined, swapped)).status).toBe(401);
    expect((await callback(jar, swapped)).status).toBe(401);
    // The starting browser finishes its own grant.
    const own = await start(jar, "own");
    expect((await callback(jar, own)).status).toBe(200);
    // Signed out between start and callback: refused.
    const later = await start(jar, "later");
    await jar.fetch("POST", "/auth/logout");
    expect((await callback(jar, later)).status).toBe(401);
    // Demoted to Member between start and callback: refused.
    const again = await signIn();
    const demoted = await start(again, "demoted");
    const second = await ctx.auth.createUser({
      loginName: "second",
      displayName: "Second owner",
      password: TEST_PASSWORD,
      role: "owner",
    });
    expect(second.id).toBeTruthy();
    ctx.auth.users.updateMembership("tnt_default", owner.id, {
      role: "member",
      workspaceId: f.a.workspace.id,
    });
    expect((await callback(again, demoted)).status).toBe(401);
    const names = ctx.db
      .prepare("SELECT connection_name FROM integration_connections WHERE revoked_at IS NULL")
      .all() as Array<{ connection_name: string }>;
    expect(names.map((row) => row.connection_name)).toEqual(["own"]);
  });
});

describe("INT-02: a tenant cannot aim the Gateway at private addresses", () => {
  it("only platform maintenance registers a private connector", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const post = (body: Record<string, unknown>) =>
      fetch(`${h.baseUrl}/api/connectors`, {
        method: "POST",
        headers: {
          cookie: `${SESSION}=${A.token}`,
          origin: h.baseUrl,
          [CSRF_HEADER]: A.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const base = { workspaceId: A.ids.workspace, url: "http://10.0.0.5:7000" };
    const refused = await post({ ...base, name: "private" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { details: { reason: string } }).details.reason).toBe(
      "private_connector",
    );
    // A public URL is the tenant Admin's to register; an IP literal never counts as public.
    expect((await post({ ...base, name: "literal", publicUrl: true })).status).toBe(400);
    expect(
      (await post({ ...base, name: "public", url: "https://api.example.com", publicUrl: true }))
        .status,
    ).toBe(201);
    // A platform maintainer acting in A may register it. The operator credential stays fixed to
    // the Default Tenant, so it cannot reach A's workspace at all.
    const viaOperator = await h.api("POST", "/api/connectors", { ...base, name: "private" });
    expect(viaOperator.status).toBe(404);
    const maintainer = await createOwner(ctx.auth, {
      loginName: "maint",
      displayName: "Maintainer",
      password: TEST_PASSWORD,
    }).catch(async () => {
      const user = await ctx.auth.createUser({
        loginName: "maint",
        displayName: "Maintainer",
        password: TEST_PASSWORD,
        role: "member",
      });
      ctx.auth.users.setPlatformRole(user.id, "maintainer");
      return user;
    });
    ctx.auth.users.addMembership(A.tenantId, maintainer.id, "admin");
    const jar = new BrowserJar(h.baseUrl);
    expect((await jar.signIn("maint")).status).toBe(200);
    const platform = await jar.json<{ connector: ConnectorRegistration }>(
      "POST",
      "/api/connectors",
      { body: { ...base, name: "private" }, headers: { [TENANT_HEADER]: A.tenantId } },
    );
    expect(platform.status).toBe(201);
    expect(platform.json.connector.name).toBe("private");
  });

  it("refuses a public connector whose name resolves to a private or metadata address", async () => {
    const fake = new FakeConnector({ baseUrl: CONNECTOR_URL, credential: CONNECTOR_CREDENTIAL });
    let answer = ["169.254.169.254"];
    const db = openDatabase(":memory:");
    cleanups.push(() => {
      db.close();
    });
    const ctx = buildContext(
      testConfig({ secretsKey: TEST_SECRETS_KEY }),
      db,
      new FakeProvider(),
      () => "http://gateway.test",
      () => {},
      { connectorFetch: fake.fetch, connectorLookup: async () => answer },
    );
    const workspace = ctx.workspaces.create({ name: "w", sandboxProvider: "docker" });
    const bot: BotDefinition = ctx.bots.create({
      name: "tester",
      role: "qa",
      workspaceId: workspace.id,
      connectors: ["tickets"],
    });
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "ssrf",
      triggerPayload: {},
      config: ctx.runConfig(),
    });
    ctx.connectors.register({
      workspaceId: workspace.id,
      name: "tickets",
      url: CONNECTOR_URL,
      credential: CONNECTOR_CREDENTIAL,
      publicUrl: true,
    });
    for (const bad of [["169.254.169.254"], ["127.0.0.1"], ["93.184.216.34", "10.0.0.1"], []]) {
      answer = bad;
      await expect(ctx.connectorProxy.describe(run.id, "tickets")).rejects.toMatchObject({
        code: "connector_unavailable",
        details: { reason: "address_not_public" },
      });
    }
    expect(fake.requests).toHaveLength(0);
    answer = ["93.184.216.34"];
    await expect(ctx.connectorProxy.describe(run.id, "tickets")).resolves.toBeDefined();
    expect(fake.requests.length).toBeGreaterThan(0);
  });
});

describe("JOB-02: natural keys never resolve across tenants", () => {
  it("a channel conversation key another tenant uses gives this tenant its own thread", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const create = (t: TenantFixture) =>
      fetch(`${h.baseUrl}/api/threads`, {
        method: "POST",
        headers: {
          cookie: `${SESSION}=${t.token}`,
          origin: h.baseUrl,
          [CSRF_HEADER]: t.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: t.ids.workspace,
          botIds: [t.ids.bot],
          channel: "whatsapp",
          externalKey: "100200:8613800000000",
        }),
      });
    const first = await create(A);
    expect(first.status).toBe(201);
    const aThread = ((await first.json()) as { thread: { id: string } }).thread.id;
    // The same key from B used to answer with A's thread and member list.
    const fromB = await create(B);
    expect(fromB.status).toBe(201);
    const bBody = JSON.stringify(await fromB.json());
    expect(bBody).not.toContain(aThread);
    expect(bBody).not.toContain(A.sentinel);
    expect(bBody).not.toContain(A.ids.bot);
    // Within one workspace the binding is still unique: a retried create finds the same thread.
    const retry = await create(A);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { thread: { id: string } }).thread.id).toBe(aThread);
  });
});

describe("DESK-01/02: the takeover lease belongs to the person who took it", () => {
  it("is not borrowed, its screen is the holder's only, and it ends with the holder's session", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    for (const login of ["holder", "other"])
      await ctx.auth.createUser({
        loginName: login,
        displayName: login,
        password: TEST_PASSWORD,
        role: "member",
        tenantId: A.tenantId,
      });
    const jar = async (login: string) => {
      const j = new BrowserJar(h.baseUrl);
      expect((await j.signIn(login)).status).toBe(200);
      return j;
    };
    const holder = await jar("holder");
    const other = await jar("other");
    const ws = A.ids.workspace;
    // The shared screen is up; the proxy reaches it, nobody else learns where.
    vi.spyOn(ctx.sandboxes, "peek").mockImplementation(async (workspaceId) => ({
      workspaceId,
      providerRef: "test",
      sidecarAddress: "test",
      novncAddress: "127.0.0.1:1",
      novncPassword: "control1",
    }));
    cleanups.push(() => {
      vi.restoreAllMocks();
    });
    expect((await holder.fetch("POST", `/api/workspaces/${ws}/takeover`)).status).toBe(200);
    expect(ctx.locks.humanHolds(ws as WorkspaceId)).toBe(true);
    // A second member can neither take it over nor open its screen nor hand it back.
    expect((await other.fetch("POST", `/api/workspaces/${ws}/takeover`)).status).toBe(409);
    expect((await other.fetch("POST", `/api/workspaces/${ws}/takeover/open-screen`)).status).toBe(
      403,
    );
    expect((await other.fetch("POST", `/api/workspaces/${ws}/handback`)).status).toBe(403);
    expect((await holder.fetch("POST", `/api/workspaces/${ws}/takeover/open-screen`)).status).toBe(
      200,
    );
    expect(ctx.locks.humanHolds(ws as WorkspaceId)).toBe(true);
    // Signing out ends the lease at once; the browser is free for the next person.
    expect((await holder.fetch("POST", "/auth/logout")).status).toBe(200);
    expect(ctx.locks.humanHolds(ws as WorkspaceId)).toBe(false);
    expect((await other.fetch("POST", `/api/workspaces/${ws}/takeover`)).status).toBe(200);
    // Removing the new holder from the tenant ends their lease on the next sweep.
    const otherUser = ctx.auth.users.findLocalLogin("other")?.userId as string;
    ctx.auth.users.updateMembership(A.tenantId, otherUser, { status: "removed" });
    ctx.auth.live.sweep();
    expect(ctx.locks.humanHolds(ws as WorkspaceId)).toBe(false);
    // An Owner may free a browser a member left held.
    const again = await jar("holder");
    expect((await again.fetch("POST", `/api/workspaces/${ws}/takeover`)).status).toBe(200);
    const owner = await fetch(`${h.baseUrl}/api/workspaces/${ws}/handback`, {
      method: "POST",
      headers: { cookie: `${SESSION}=${A.token}`, origin: h.baseUrl, [CSRF_HEADER]: A.csrf },
    });
    expect(owner.status).toBe(200);
    expect(ctx.locks.humanHolds(ws as WorkspaceId)).toBe(false);
  });
});

describe("DESK-01: desktop tickets follow the lease holder and the ticket's tenant", () => {
  it("refuses control to a non-holder and a socket whose tenant membership ended", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const vnc = await startFakeVnc({ control: "control1", view: "viewonly" });
    cleanups.push(() => vnc.close());
    const address = vnc.address;
    vi.spyOn(ctx.sandboxes, "peek").mockImplementation(async (workspaceId) => ({
      workspaceId,
      providerRef: "test",
      sidecarAddress: "test",
      botScreenAddresses: Array(6).fill(address),
      novncPassword: "control1",
      novncViewPassword: "viewonly",
    }));
    cleanups.push(() => {
      vi.restoreAllMocks();
    });
    ctx.screens.ensure(A.ids.bot as BotId, A.ids.workspace as WorkspaceId);
    ctx.screens.ensure(B.ids.bot as BotId, B.ids.workspace as WorkspaceId);
    for (const login of ["holder", "other", "both"])
      await ctx.auth.createUser({
        loginName: login,
        displayName: login,
        password: TEST_PASSWORD,
        role: "member",
        tenantId: A.tenantId,
      });
    const both = ctx.auth.users.findLocalLogin("both")?.userId as string;
    ctx.auth.users.addMembership(B.tenantId, both, "member");
    const jar = async (login: string) => {
      const j = new BrowserJar(h.baseUrl);
      expect((await j.signIn(login)).status).toBe(200);
      return j;
    };
    const holder = await jar("holder");
    const other = await jar("other");
    const access = (j: BrowserJar, bot: string, mode: string, headers = {}) =>
      j.json<ScreenAccess & { reason?: string }>("POST", `/api/bots/${bot}/screen/access`, {
        body: { mode },
        headers,
      });
    expect((await holder.fetch("POST", `/api/workspaces/${A.ids.workspace}/takeover`)).status).toBe(
      200,
    );
    // While someone holds the browser, another member may watch but not drive it.
    const refused = await access(other, A.ids.bot, "control");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain("not_holder");
    expect((await access(other, A.ids.bot, "view")).status).toBe(200);
    expect((await access(holder, A.ids.bot, "control")).status).toBe(200);
    // A ticket issued in tenant B is redeemed only while the session is still a member of B.
    const member = await jar("both");
    const open = async (ticket: ScreenAccess) => {
      const socket = new WebSocket(
        `${h.baseUrl.replace("http:", "ws:")}${ticket.path}`,
        [ticket.protocol],
        { origin: h.baseUrl },
      );
      const outcome = await new Promise<string>((resolve) => {
        socket.once("message", (data) => resolve(String(data)));
        socket.once("error", (error) => resolve(String(error)));
      });
      socket.terminate();
      return outcome;
    };
    const inB = { [TENANT_HEADER]: B.tenantId };
    const kept = await access(member, B.ids.bot, "view", inB);
    expect(kept.status).toBe(200);
    // The proxy authenticated upstream and now greets the browser as an RFB server.
    expect(await open(kept.json)).toBe("RFB 003.008\n");
    const ticket = await access(member, B.ids.bot, "view", inB);
    expect(ticket.status).toBe(200);
    // Hold the periodic sweep, which would drop the ticket first: the upgrade itself must check.
    ctx.auth.live.stop();
    ctx.auth.users.updateMembership(B.tenantId, both, { status: "removed" });
    expect(await open(ticket.json)).toContain("401");
  });
});

describe("RUN-01: run tokens and browser sessions are separate credential classes", () => {
  it("a run token reaches only its own run; a session cookie reaches no run route", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const { token } = ctx.tokens.issue(A.ids.run as never);
    const get = (path: string, headers: Record<string, string>) =>
      fetch(`${h.baseUrl}${path}`, { headers });
    const bearer = { authorization: `Bearer ${token}` };
    expect((await get(`/internal/runs/${A.ids.run}/egress`, bearer)).status).toBe(200);
    // Another tenant's run, and every operator route, refuse it.
    expect([401, 403]).toContain((await get(`/internal/runs/${B.ids.run}/egress`, bearer)).status);
    expect((await get("/api/workspaces", bearer)).status).toBe(401);
    expect((await get(`/api/runs/${A.ids.run}`, bearer)).status).toBe(401);
    // A signed-in browser's cookie is not a run credential.
    const cookie = { cookie: `${SESSION}=${A.token}` };
    expect((await get(`/internal/runs/${A.ids.run}/egress`, cookie)).status).toBe(401);
    expect((await get("/api/workspaces", cookie)).status).toBe(200);
  });
});

describe("EVT-01: the stream's tenant selector in the query", () => {
  it("is honoured on /api/events only, and still checked against the session", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const user = await ctx.auth.createUser({
      loginName: "both",
      displayName: "Both",
      password: TEST_PASSWORD,
      role: "admin",
      tenantId: A.tenantId,
    });
    ctx.auth.users.addMembership(B.tenantId, user.id, "admin");
    const { token } = await ctx.auth.login("both", TEST_PASSWORD, "test");
    const inB = (await openStream(h, token, { query: `?tenant=${B.tenantId}` })).stream as Stream;
    publishEverything(h, A);
    publishEverything(h, B);
    await waitFor(() => inB.text().includes("event: cost_alert"), 3000, "B events");
    expect(inB.text()).toContain(B.sentinel);
    expect(inB.text()).not.toContain(A.sentinel);
    // A tenant the session cannot enter is refused, not ignored.
    expect((await openStream(h, A.token, { query: `?tenant=${B.tenantId}` })).status).toBe(401);
    // Elsewhere the query parameter selects nothing: the session's default tenant applies.
    const listed = await fetch(`${h.baseUrl}/api/workspaces?tenant=${B.tenantId}`, {
      headers: { cookie: `${SESSION}=${A.token}` },
    });
    expect(JSON.stringify(await listed.json())).not.toContain(B.sentinel);
  });
});

describe("DESK-02: the takeover lease survives a restart and ends with its session", () => {
  it("keeps the holder across a restart and releases it when the session is revoked elsewhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-desk-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "gateway.sqlite");
    const first = await startHarness({ auth: FAST_AUTH, secretsKey: TEST_SECRETS_KEY, dbPath });
    const ctx1 = first.app.deskmates.ctx;
    const A = await seedTenant(ctx1, "A");
    for (const login of ["holder", "other"])
      await ctx1.auth.createUser({
        loginName: login,
        displayName: login,
        password: TEST_PASSWORD,
        role: "member",
        tenantId: A.tenantId,
      });
    const holder = await ctx1.auth.login("holder", TEST_PASSWORD, "t");
    const other = await ctx1.auth.login("other", TEST_PASSWORD, "t");
    const post = (h: Harness, token: string, path: string) =>
      fetch(`${h.baseUrl}${path}`, {
        method: "POST",
        headers: {
          cookie: `${SESSION}=${token}`,
          origin: h.baseUrl,
          [CSRF_HEADER]: csrfTokenFor(token),
        },
      });
    const ws = A.ids.workspace;
    expect((await post(first, holder.token, `/api/workspaces/${ws}/takeover`)).status).toBe(200);
    await first.close();

    // A database with a second tenant is only served in multi mode.
    const second = await startHarness({
      auth: FAST_AUTH,
      secretsKey: TEST_SECRETS_KEY,
      dbPath,
      tenancy: "multi",
    });
    cleanups.push(() => second.close());
    const ctx2 = second.app.deskmates.ctx;
    expect(ctx2.locks.humanHolds(ws as WorkspaceId)).toBe(true);
    vi.spyOn(ctx2.sandboxes, "peek").mockImplementation(async (workspaceId) => ({
      workspaceId,
      providerRef: "test",
      sidecarAddress: "test",
      novncAddress: "127.0.0.1:1",
      novncPassword: "control1",
    }));
    cleanups.push(() => {
      vi.restoreAllMocks();
    });
    // After the restart the same person still holds it; nobody else can borrow it.
    expect(
      (await post(second, holder.token, `/api/workspaces/${ws}/takeover/open-screen`)).status,
    ).toBe(200);
    expect((await post(second, other.token, `/api/workspaces/${ws}/takeover`)).status).toBe(409);
    // Revoked outside this process (the maintenance CLI writes the database directly).
    ctx2.db
      .prepare(
        "UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'maintenance' WHERE id = ?",
      )
      .run(new Date().toISOString(), holder.session.id);
    await waitFor(() => !ctx2.locks.humanHolds(ws as WorkspaceId), 2000, "lease released");
    expect((await post(second, other.token, `/api/workspaces/${ws}/takeover`)).status).toBe(200);
  });
});

describe("LIMIT-01: per-tenant queue, request and disk limits", () => {
  const sessionPost = (h: Harness, t: TenantFixture, path: string, body: unknown) =>
    fetch(`${h.baseUrl}${path}`, {
      method: "POST",
      headers: {
        cookie: `${SESSION}=${t.token}`,
        origin: h.baseUrl,
        [CSRF_HEADER]: t.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("a full queue refuses a tenant's new work at every intake, and only that tenant's", async () => {
    // Nothing launches, so every new run stays queued; each seeded tenant starts with one.
    const h = await harness({ tenantMaxQueuedRuns: 2 });
    h.app.deskmates.scheduler.stop();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const say = (t: TenantFixture) =>
      sessionPost(h, t, `/api/threads/${t.ids.thread}/messages`, { body: "hello" });
    ctx.runs.create({
      botId: A.ids.bot as never,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "fill",
      triggerPayload: {},
      config: ctx.runConfig(),
    });
    expect(ctx.quotas.queuedRuns(A.tenantId)).toBe(2);
    expect(ctx.quotas.queuedRuns(B.tenantId)).toBe(1);
    const full = await say(A);
    expect(full.status).toBe(429);
    expect(((await full.json()) as { code: string }).code).toBe("queue_full");
    expect(ctx.quotas.queuedRuns(A.tenantId)).toBe(2);
    // A webhook delivery and a bot's own message for A are refused the same way.
    const { hashWebhookToken, newWebhookToken } = await import("../bots/webhook-token.js");
    const hook = newWebhookToken();
    ctx.db
      .prepare("UPDATE bots SET webhook_token_hash = ? WHERE id = ?")
      .run(hashWebhookToken(hook), A.ids.bot);
    const delivered = await fetch(`${h.baseUrl}/hooks/${A.ids.bot}/${hook}`, {
      method: "POST",
      body: "event",
    });
    expect(delivered.status).toBe(429);
    const { token } = ctx.tokens.issue(A.ids.run as never);
    const botPost = await fetch(`${h.baseUrl}/internal/runs/${A.ids.run}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "thread_post", body: "@everyone go" }),
    });
    expect(botPost.status).toBe(429);
    // B is unaffected.
    expect((await say(B)).status).toBe(201);
  });

  it("a tenant over its request rate is refused while another tenant is served", async () => {
    const h = await harness({ tenantApiRequestsPerMinute: 5 });
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const get = (t: TenantFixture) =>
      fetch(`${h.baseUrl}/api/workspaces`, { headers: { cookie: `${SESSION}=${t.token}` } });
    for (let i = 0; i < 5; i += 1) expect((await get(A)).status).toBe(200);
    const limited = await get(A);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { code: string; details: { retryAfterSeconds: number } };
    expect(body.code).toBe("rate_limited");
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect((await get(B)).status).toBe(200);
    // The event stream is not a request against the budget.
    expect((await openStream(h, A.token)).status).toBe(200);
  });

  it("one tenant's open streams and desktop connections cannot use up another's", async () => {
    const h = await harness({ tenantMaxEventStreams: 2, tenantMaxDesktopConnections: 2 });
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    // Event streams stay open, so the request budget does not bound them.
    expect((await openStream(h, A.token)).status).toBe(200);
    expect((await openStream(h, A.token)).status).toBe(200);
    expect((await openStream(h, A.token)).status).toBe(429);
    expect((await openStream(h, B.token)).status).toBe(200);
    // Desktop tickets count until redeemed or expired, then as open streams.
    vi.spyOn(ctx.sandboxes, "peek").mockImplementation(async (workspaceId) => ({
      workspaceId,
      providerRef: "test",
      sidecarAddress: "test",
      botScreenAddresses: Array(6).fill("127.0.0.1:1"),
      novncPassword: "control1",
      novncViewPassword: "viewonly",
    }));
    cleanups.push(() => {
      vi.restoreAllMocks();
    });
    for (const t of [A, B]) ctx.screens.ensure(t.ids.bot as BotId, t.ids.workspace as WorkspaceId);
    const ticket = (t: TenantFixture) =>
      fetch(`${h.baseUrl}/api/bots/${t.ids.bot}/screen/access`, {
        method: "POST",
        headers: {
          cookie: `${SESSION}=${t.token}`,
          origin: h.baseUrl,
          [CSRF_HEADER]: t.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode: "view" }),
      });
    expect((await ticket(A)).status).toBe(200);
    expect((await ticket(A)).status).toBe(200);
    const refused = await ticket(A);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe("queue_full");
    expect((await ticket(B)).status).toBe(200);
  });

  it("a workspace over its disk quota starts no new run until it is under it again", async () => {
    const h = await harness({ workspaceDiskQuotaMb: 100 });
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    let usedMb = 150;
    const exec = h.provider.exec.bind(h.provider);
    h.provider.exec = async (handle, req) =>
      req.cmd[0] === "du"
        ? {
            exitCode: 0,
            stdout: `${usedMb}\t/work\n${usedMb}\ttotal\n`,
            stderr: "",
            timedOut: false,
          }
        : exec(handle, req);
    const scheduler = h.app.deskmates.scheduler;
    // The seeded run starts (nothing measured yet) and its end measures the workspace.
    scheduler.tick();
    await waitFor(
      () => scheduler.diskUsage(A.ids.workspace as WorkspaceId) === 150,
      3000,
      "measured",
    );
    const next = ctx.runs.create({
      botId: A.ids.bot as never,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "disk",
      triggerPayload: {},
      config: ctx.runConfig(),
    });
    scheduler.tick();
    await waitFor(
      () =>
        ctx.events
          .list(next.id)
          .some(
            (e) => (e.payload as { waitReason?: string }).waitReason === "workspace_disk_quota",
          ),
      3000,
      "waiting on disk",
    );
    expect(ctx.runs.mustGet(next.id).status).toBe("queued");
    usedMb = 40;
    await scheduler.measureDisk(A.ids.workspace as WorkspaceId);
    await waitFor(
      () => ctx.runs.mustGet(next.id).status === "succeeded",
      3000,
      "ran after cleanup",
    );
  });
});

describe("INT-02: a public connector's connection is pinned to the address that was checked", () => {
  it("connects to the checked address even when the name resolves nowhere else", async () => {
    const { createServer } = await import("node:http");
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const answer = await fake.fetch(`${base}${req.url}`, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
      });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(await answer.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    // `.test` never resolves in DNS: only a pinned connection can reach the server.
    const base = `http://rebind.example.test:${port}`;
    const fake = new FakeConnector({ baseUrl: base, credential: CONNECTOR_CREDENTIAL });
    const lookups: string[] = [];
    const db = openDatabase(":memory:");
    cleanups.push(() => {
      db.close();
    });
    const ctx = buildContext(
      testConfig({ secretsKey: TEST_SECRETS_KEY }),
      db,
      new FakeProvider(),
      () => "http://gateway.test",
      () => {},
      {
        // The real connector fetch (undici); only the resolver is scripted.
        connectorLookup: async (host) => {
          lookups.push(host);
          return ["127.0.0.1"];
        },
      },
    );
    // Loopback is a private address; this test admits it to show where the connection went.
    (
      ctx.connectorProxy as unknown as { deps: { addressAllowed: () => boolean } }
    ).deps.addressAllowed = () => true;
    const workspace = ctx.workspaces.create({ name: "w", sandboxProvider: "docker" });
    const bot = ctx.bots.create({
      name: "tester",
      role: "qa",
      workspaceId: workspace.id,
      connectors: ["tickets"],
    });
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "pin",
      triggerPayload: {},
      config: ctx.runConfig(),
    });
    ctx.connectors.register({
      workspaceId: workspace.id,
      name: "tickets",
      url: base,
      credential: CONNECTOR_CREDENTIAL,
      publicUrl: true,
    });
    await expect(ctx.connectorProxy.describe(run.id, "tickets")).resolves.toBeDefined();
    expect(lookups).toEqual(["rebind.example.test"]);
    expect(fake.requests.length).toBeGreaterThan(0);
  });
});

describe("FILE-01: a file is read only in its own tenant's workspace container", () => {
  it("refuses another tenant before any command runs, and reads the owner's in its own sandbox", async () => {
    const h = await harness();
    const ctx = h.app.deskmates.ctx;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    for (const t of [A, B])
      h.provider.existing.set(t.ids.workspace, {
        workspaceId: t.ids.workspace as WorkspaceId,
        providerRef: `container-of-${t.tenantId}`,
        sidecarAddress: "127.0.0.1:1",
      });
    const reads: string[] = [];
    const exec = h.provider.exec.bind(h.provider);
    h.provider.exec = async (handle, req) => {
      if (req.cmd[1] !== "file-read") return exec(handle, req);
      reads.push(handle.providerRef);
      const bytes = Buffer.from(`file of ${handle.providerRef}`);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ base64: bytes.toString("base64"), size: bytes.length })}\n`,
        stderr: "",
        timedOut: false,
      };
    };
    const read = (t: TenantFixture, workspaceId: string) =>
      fetch(
        `${h.baseUrl}/api/workspaces/${workspaceId}/files?path=${encodeURIComponent("/work/report.md")}`,
        {
          headers: { cookie: `${SESSION}=${t.token}` },
        },
      );
    const foreign = await read(B, A.ids.workspace);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ code: "not_found", message: "Not found", details: {} });
    expect(reads).toEqual([]);
    const own = await read(A, A.ids.workspace);
    expect(own.status).toBe(200);
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(own.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(await own.text()).toBe(`file of container-of-${A.tenantId}`);
    expect(reads).toEqual([`container-of-${A.tenantId}`]);
  });
});
