// T1: roles are checked per workspace (ADR-0031 decision 7). The former tenant role checks
// resolve against the membership in the workspace a request names: an Admin of one workspace
// is nobody in another, and a person with no workspace role above Member creates no workspace.

import type { Workspace } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { TEST_SECRETS_KEY } from "../test-support/connector-fixture.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("per-workspace roles (ADR-0031 decision 7)", () => {
  it("an Admin of one workspace acts there and is refused in another", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const a = ctx.workspaces.create({ name: "A", sandboxProvider: "docker" });
    const b = ctx.workspaces.create({ name: "B", sandboxProvider: "docker" });
    const botA = ctx.bots.create({ workspaceId: a.id, name: "bot-a", role: "r" });
    const botB = ctx.bots.create({ workspaceId: b.id, name: "bot-b", role: "r" });
    await ctx.auth.createUser({
      loginName: "ada",
      displayName: "Ada",
      password: TEST_PASSWORD,
      role: "admin",
      workspaceId: a.id,
    });
    const jar = new BrowserJar(h.baseUrl);
    expect((await jar.signIn("ada")).status).toBe(200);
    const patch = { cron: [{ schedule: "0 9 * * *", prompt: "daily" }] };
    expect((await jar.fetch("PATCH", `/api/bots/${botA.id}`, { body: patch })).status).toBe(200);
    // A workspace she does not belong to is the uniform 404 (ADR-0022 amendment 6 W1).
    const foreign = await jar.json("PATCH", `/api/bots/${botB.id}`, { body: patch });
    expect(foreign.status).toBe(404);
    // As a Member of B the same request is a role refusal there.
    ctx.auth.memberships.add(
      b.id,
      ctx.auth.users.findLocalLogin("ada")?.userId as string,
      "member",
      "user:test",
    );
    const refused = await jar.json<{ details?: { reason?: string } }>(
      "PATCH",
      `/api/bots/${botB.id}`,
      { body: patch },
    );
    expect(refused.status).toBe(403);
    expect(refused.json.details?.reason).toBe("workspace_role");
    // The workspace she creates is hers to own; the root owns it too.
    const created = await jar.json<{ workspace: { id: string } }>("POST", "/api/workspaces", {
      body: { name: "C" },
    });
    expect(created.status).toBe(201);
    const ada = ctx.auth.users.findLocalLogin("ada")?.userId as string;
    expect(ctx.auth.memberships.roleIn(created.json.workspace.id, ada)).toBe("owner");
  });

  it("a person with no workspace role above Member creates no workspace (owner answer Q1)", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const a = ctx.workspaces.create({ name: "A", sandboxProvider: "docker" });
    await ctx.auth.createUser({
      loginName: "mel",
      displayName: "Mel",
      password: TEST_PASSWORD,
      role: "member",
      workspaceId: a.id,
    });
    const jar = new BrowserJar(h.baseUrl);
    expect((await jar.signIn("mel")).status).toBe(200);
    expect((await jar.fetch("POST", "/api/workspaces", { body: { name: "D" } })).status).toBe(403);
  });

  it("lists show only the caller's workspaces (ADR-0022 amendment 6 W1)", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const a = ctx.workspaces.create({ name: "A", sandboxProvider: "docker" });
    const b = ctx.workspaces.create({ name: "B", sandboxProvider: "docker" });
    const botA = ctx.bots.create({ workspaceId: a.id, name: "bot-a", role: "r" });
    const botB = ctx.bots.create({ workspaceId: b.id, name: "bot-b", role: "r" });
    const threadB = ctx.threads.create({ workspaceId: b.id, botIds: [botB.id] });
    await ctx.auth.createUser({
      loginName: "mel",
      displayName: "Mel",
      password: TEST_PASSWORD,
      role: "member",
      workspaceId: a.id,
    });
    const jar = new BrowserJar(h.baseUrl);
    expect((await jar.signIn("mel")).status).toBe(200);
    const workspaces = await jar.json<{ workspaces: Array<{ id: string }> }>(
      "GET",
      "/api/workspaces",
    );
    expect(workspaces.json.workspaces.map((w) => w.id)).toEqual([a.id]);
    const bots = await jar.json<{ bots: Array<{ id: string }> }>("GET", "/api/bots");
    expect(bots.json.bots.map((bot) => bot.id)).toEqual([botA.id]);
    const threads = await jar.json<{ threads: Array<{ id: string }> }>("GET", "/api/threads");
    expect(threads.json.threads.map((t) => t.id)).not.toContain(threadB.id);
    expect((await jar.fetch("GET", `/api/threads/${threadB.id}`)).status).toBe(404);
    const session = await jar.json<{
      workspaceRoles: Array<{ workspaceId: string; role: string }>;
    }>("GET", "/auth/session");
    expect(session.json.workspaceRoles).toEqual([{ workspaceId: a.id, role: "member" }]);
  });

  it("budget, cost, connector and trash lists show only the caller's workspaces (W1)", async () => {
    h = await startHarness({ auth: FAST_AUTH, secretsKey: TEST_SECRETS_KEY });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const [a, b, c, d, e] = ["A", "B", "C", "D", "E"].map((name) =>
      ctx.workspaces.create({ name, sandboxProvider: "docker" }),
    ) as [Workspace, Workspace, Workspace, Workspace, Workspace];
    const ada = await ctx.auth.createUser({
      loginName: "ada",
      displayName: "Ada",
      password: TEST_PASSWORD,
      role: "admin",
      workspaceId: a.id,
    });
    ctx.auth.memberships.add(b.id, ada.id, "member", "test");
    ctx.auth.memberships.add(e.id, ada.id, "admin", "test");
    const botA = ctx.bots.create({ workspaceId: a.id, name: "bot-a", role: "r" });
    const botC = ctx.bots.create({ workspaceId: c.id, name: "bot-c", role: "r" });
    for (const [bot, tokens] of [
      [botA, 10],
      [botC, 1000],
    ] as const) {
      ctx.db
        .prepare(
          `INSERT INTO runs
             (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at)
           VALUES (?, ?, ?, 'interactive', 'succeeded', 'thread_message', 'message',
                   '2026-09-23T10:00:00.000Z')`,
        )
        .run(bot.workspaceId, `run-${bot.name}`, bot.id);
      ctx.db
        .prepare(
          `INSERT INTO run_usage
             (run_id, attempt, model, input_tokens, output_tokens,
              cache_read_tokens, cache_create_tokens, cost_usd)
           VALUES (?, 1, 'model-a', ?, 0, 0, 0, NULL)`,
        )
        .run(`run-${bot.name}`, tokens);
      ctx.connectors.register({
        workspaceId: bot.workspaceId,
        name: `tickets-${bot.name}`,
        url: "https://connector.example.test",
        publicUrl: true,
      });
    }
    ctx.bots.archive(ctx.bots.create({ workspaceId: a.id, name: "old-a", role: "r" }).id, "test");
    ctx.bots.archive(ctx.bots.create({ workspaceId: c.id, name: "old-c", role: "r" }).id, "test");
    for (const archived of [b, d, e]) ctx.workspaces.archive(archived.id, "test");
    const jar = new BrowserJar(h.baseUrl);
    expect((await jar.signIn("ada")).status).toBe(200);

    const budgets = await jar.json<{ budgets: Array<{ workspaceId: string }> }>(
      "GET",
      "/api/budgets",
    );
    expect(budgets.status).toBe(200);
    expect(budgets.json.budgets.map((x) => x.workspaceId)).toEqual([a.id]);
    const costs = await jar.json<{ totals: { inputTokens: number } }>("GET", "/api/costs");
    expect(costs.json.totals.inputTokens).toBe(10);
    const rows = await jar.json<{ rows: Array<{ workspaceId: string }>; total: number }>(
      "GET",
      "/api/costs/rows",
    );
    expect(rows.json.rows.map((r) => r.workspaceId)).toEqual([a.id]);
    expect(rows.json.total).toBe(1);
    const ranking = await jar.json<{ entries: Array<{ key: string }> }>(
      "GET",
      "/api/costs/ranking?by=workspace",
    );
    expect(ranking.json.entries.map((x) => x.key)).toEqual([a.id]);
    const connectors = await jar.json<{
      connectors: Array<{ workspaceId: string }>;
      total: number;
    }>("GET", "/api/connectors");
    expect(connectors.json.connectors.map((x) => x.workspaceId)).toEqual([a.id]);
    expect(connectors.json.total).toBe(1);
    // Trash takes Admin: the archived workspace E where Ada is Admin, not B where she is a
    // Member nor D where she is nobody; only A's archived bot.
    const trash = await jar.json<{
      workspaces: Array<{ id: string }>;
      total: number;
      bots: Array<{ name: string }>;
    }>("GET", "/api/trash");
    expect(trash.status).toBe(200);
    expect(trash.json.workspaces.map((w) => w.id)).toEqual([e.id]);
    expect(trash.json.total).toBe(1);
    expect(trash.json.bots.map((bot) => bot.name)).toEqual(["old-a"]);
    // The root still sees the whole tenant.
    const root = new BrowserJar(h.baseUrl);
    expect((await root.signIn("root")).status).toBe(200);
    const all = await root.json<{ totals: { inputTokens: number } }>("GET", "/api/costs");
    expect(all.json.totals.inputTokens).toBe(1010);
    const rootTrash = await root.json<{ total: number }>("GET", "/api/trash");
    expect(rootTrash.json.total).toBe(3);
  });

  it("an Admin of one workspace cannot end another person's browser lease in a workspace where they are a Member", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const a = ctx.workspaces.create({ name: "A", sandboxProvider: "docker" });
    const b = ctx.workspaces.create({ name: "B", sandboxProvider: "docker" });
    await ctx.auth.createUser({
      loginName: "oona",
      displayName: "Oona",
      password: TEST_PASSWORD,
      role: "owner",
      workspaceId: b.id,
    });
    const ada = await ctx.auth.createUser({
      loginName: "ada",
      displayName: "Ada",
      password: TEST_PASSWORD,
      role: "admin",
      workspaceId: a.id,
    });
    ctx.auth.memberships.add(b.id, ada.id, "member", "test");
    const signIn = async (login: string) => {
      const jar = new BrowserJar(h?.baseUrl as string);
      expect((await jar.signIn(login)).status).toBe(200);
      return jar;
    };
    const owner = await signIn("oona");
    const admin = await signIn("ada");
    expect((await owner.fetch("POST", `/api/workspaces/${b.id}/takeover`)).status).toBe(200);
    const refused = await admin.json<{ details?: { reason?: string } }>(
      "POST",
      `/api/workspaces/${b.id}/handback`,
    );
    expect(refused.status).toBe(403);
    expect(refused.json.details?.reason).toBe("not_holder");
    expect(typeof ctx.locks.humanHolder(b.id)).toBe("string");
    // An Admin of B, here the root, may free a browser someone left held.
    const root = await signIn("root");
    expect((await root.fetch("POST", `/api/workspaces/${b.id}/handback`)).status).toBe(200);
    expect(ctx.locks.humanHolder(b.id)).toBeUndefined();
  });

  it("service principals are the root's (ADR-0031 Q2)", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const a = ctx.workspaces.create({ name: "A", sandboxProvider: "docker" });
    await ctx.auth.createUser({
      loginName: "oona",
      displayName: "Oona",
      password: TEST_PASSWORD,
      role: "owner",
      workspaceId: a.id,
    });
    const owner = new BrowserJar(h.baseUrl);
    expect((await owner.signIn("oona")).status).toBe(200);
    const refused = await owner.json<{ details?: { reason?: string } }>(
      "POST",
      "/api/service-principals",
      { body: { name: "agent" } },
    );
    expect(refused.status).toBe(403);
    expect(refused.json.details?.reason).toBe("root_only");
    const root = new BrowserJar(h.baseUrl);
    expect((await root.signIn("root")).status).toBe(200);
    expect(
      (await root.fetch("POST", "/api/service-principals", { body: { name: "agent" } })).status,
    ).toBe(201);
  });
});
