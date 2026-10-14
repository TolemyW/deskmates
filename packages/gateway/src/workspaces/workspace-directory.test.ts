// T1: the workspace directory query (ADR-0034 decisions 3, 5 and 6). Bounded pages, an honest
// total, a stable order on equal timestamps, membership scoping and authorized aggregates.

import type { WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { WorkspaceDirectory } from "./workspace-directory.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const OWNER = { everywhere: "owner" as const };

async function setup() {
  h = await startHarness({ auth: FAST_AUTH });
  h.app.deskmates.scheduler.stop();
  const { ctx } = h.app.deskmates;
  await createOwner(ctx.auth, { loginName: "root", displayName: "Root", password: TEST_PASSWORD });
  return { ctx, directory: new WorkspaceDirectory(ctx.db) };
}

describe("WorkspaceDirectory", () => {
  it("pages 45 workspaces in three pages with a stable order and the whole total", async () => {
    const { ctx, directory } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 45; i++)
      ids.push(ctx.workspaces.create({ name: `ws ${i}`, sandboxProvider: "docker" }).id);
    // Equal activity timestamps everywhere: the order falls back to the id.
    ctx.db.prepare("UPDATE workspaces SET created_at = '2026-10-01T00:00:00.000Z'").run();
    const seen: string[] = [];
    for (const offset of [0, 20, 40]) {
      const page = directory.page({
        tenantId: DEFAULT_TENANT_ID,
        viewer: OWNER,
        filter: "all",
        offset,
        limit: 20,
      });
      expect(page.total).toBe(45);
      seen.push(...page.workspaces.map((w) => w.id));
    }
    expect(seen).toEqual([...ids].sort());
    const past = directory.page({
      tenantId: DEFAULT_TENANT_ID,
      viewer: OWNER,
      filter: "all",
      offset: 60,
      limit: 20,
    });
    expect(past).toEqual({ workspaces: [], total: 45 });
  });

  it("orders by last activity, searches by name and id, and filters by role", async () => {
    const { ctx, directory } = await setup();
    const quiet = ctx.workspaces.create({ name: "Quiet_lab", sandboxProvider: "docker" });
    const busy = ctx.workspaces.create({ name: "研究 busy", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ workspaceId: busy.id, name: "b", role: "r" });
    const thread = ctx.threads.create({ workspaceId: busy.id, botIds: [bot.id] });
    ctx.db
      .prepare("UPDATE threads SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?")
      .run(thread.id);
    const all = directory.page({
      tenantId: DEFAULT_TENANT_ID,
      viewer: OWNER,
      filter: "all",
      offset: 0,
      limit: 20,
    });
    expect(all.workspaces.map((w) => w.id).slice(0, 2)).toEqual([busy.id, quiet.id]);
    expect(all.workspaces[0]).toMatchObject({
      lastActivityAt: "2099-01-01T00:00:00.000Z",
      botCount: 1,
      activeRuns: 0,
      myRole: "owner",
    });
    const search = (q: string) =>
      directory
        .page({
          tenantId: DEFAULT_TENANT_ID,
          viewer: OWNER,
          filter: "all",
          q,
          offset: 0,
          limit: 20,
        })
        .workspaces.map((w) => w.id);
    expect(search("quiet")).toEqual([quiet.id]);
    expect(search("研究")).toEqual([busy.id]);
    expect(search(quiet.id)).toEqual([quiet.id]);
    // `_` and `%` are literal, not wildcards.
    expect(search("t_l")).toEqual([quiet.id]);
    expect(search("%")).toEqual([]);
    expect(
      directory.page({
        tenantId: DEFAULT_TENANT_ID,
        viewer: OWNER,
        filter: "all",
        role: "guest",
        offset: 0,
        limit: 20,
      }).total,
    ).toBe(0);
  });

  it("shows a person only their workspaces, hides running work below Admin and others' private chats", async () => {
    const { ctx, directory } = await setup();
    const mine = ctx.workspaces.create({ name: "mine", sandboxProvider: "docker" });
    ctx.workspaces.create({ name: "not mine", sandboxProvider: "docker" });
    const mel = await ctx.auth.createUser({
      loginName: "mel",
      displayName: "Mel",
      password: TEST_PASSWORD,
      role: "member",
      workspaceId: mine.id,
    });
    const other = await ctx.auth.createUser({
      loginName: "max",
      displayName: "Max",
      password: TEST_PASSWORD,
      role: "member",
      workspaceId: mine.id,
    });
    const bot = ctx.bots.create({ workspaceId: mine.id, name: "b", role: "r" });
    const secret = ctx.threads.create({ workspaceId: mine.id, botIds: [bot.id] });
    ctx.db
      .prepare(
        "UPDATE threads SET private_to_user_id = ?, updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(other.id, secret.id);
    ctx.runs.create({
      botId: bot.id,
      threadId: secret.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "m1",
      config: {},
    });
    const page = directory.page({
      tenantId: DEFAULT_TENANT_ID,
      viewer: { userId: mel.id },
      filter: "all",
      offset: 0,
      limit: 20,
    });
    expect(page.total).toBe(1);
    expect(page.workspaces[0]).toMatchObject({ id: mine.id, myRole: "member", activeRuns: null });
    expect(page.workspaces[0]?.lastActivityAt).not.toBe("2099-01-01T00:00:00.000Z");
    // Max sees his own private chat's time; the Owner sees the running work.
    const max = directory.page({
      tenantId: DEFAULT_TENANT_ID,
      viewer: { userId: other.id },
      filter: "all",
      offset: 0,
      limit: 20,
    });
    expect(max.workspaces[0]?.lastActivityAt).toBe("2099-01-01T00:00:00.000Z");
    const owner = directory.page({
      tenantId: DEFAULT_TENANT_ID,
      viewer: OWNER,
      filter: "all",
      q: "mine",
      offset: 0,
      limit: 20,
    });
    expect(owner.workspaces.find((w) => w.id === mine.id)?.activeRuns).toBe(1);
    // Archived workspaces are listed to Admins and Owners only.
    ctx.workspaces.archive(mine.id as WorkspaceId, "user:test");
    const archived = (viewer: { userId: string } | typeof OWNER) =>
      directory.page({
        tenantId: DEFAULT_TENANT_ID,
        viewer,
        filter: "archived",
        offset: 0,
        limit: 20,
      }).total;
    expect(archived({ userId: mel.id })).toBe(0);
    expect(archived(OWNER)).toBe(1);
  });

  it("keeps pins per person", async () => {
    const { ctx, directory } = await setup();
    const a = ctx.workspaces.create({ name: "a", sandboxProvider: "docker" });
    const b = ctx.workspaces.create({ name: "b", sandboxProvider: "docker" });
    const people = [];
    for (const login of ["p1", "p2"])
      people.push(
        await ctx.auth.createUser({
          loginName: login,
          displayName: login,
          password: TEST_PASSWORD,
          role: "member",
          workspaceId: a.id,
        }),
      );
    const [p1, p2] = people.map((p) => p.id) as [string, string];
    ctx.auth.memberships.add(b.id, p1, "member", "user:test");
    directory.setPinned(p1, b.id, true);
    directory.setPinned(p1, b.id, true);
    const pinned = (userId: string) =>
      directory.page({
        tenantId: DEFAULT_TENANT_ID,
        viewer: { userId },
        filter: "pinned",
        offset: 0,
        limit: 20,
      });
    expect(pinned(p1).workspaces.map((w) => w.id)).toEqual([b.id]);
    expect(pinned(p2).total).toBe(0);
    directory.setPinned(p1, b.id, false);
    expect(pinned(p1).total).toBe(0);
    expect(() =>
      directory.page({
        tenantId: DEFAULT_TENANT_ID,
        viewer: OWNER,
        filter: "pinned",
        offset: 0,
        limit: 5,
      }),
    ).toThrow(/pins belong to a person/);
  });
});
