// T1: roles are checked per workspace (ADR-0031 decision 7). The former tenant role checks
// resolve against the membership in the workspace a request names: an Admin of one workspace
// is nobody in another, and a person with no workspace role above Member creates no workspace.

import { afterEach, describe, expect, it } from "vitest";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
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
