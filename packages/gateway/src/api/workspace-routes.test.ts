// T1: workspace name bounds on create and rename, the directory route and personal pins
// (ADR-0034 decisions 2, 3 and 6).

import type { WorkspaceDirectoryPage, WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface ErrorBody {
  error?: string;
  details?: { field?: string; units?: number; max?: number };
}

function auditCount(harness: Harness, action: string): number {
  return (
    harness.app.deskmates.ctx.db
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = ?")
      .get(action) as { n: number }
  ).n;
}

describe("workspace names (ADR-0034 decisions 1 and 2)", () => {
  it("create refuses an over-long name with its width and writes nothing", async () => {
    h = await startHarness();
    const before = h.app.deskmates.ctx.workspaces.list().length;
    const audits = auditCount(h, "workspace.create");
    const res = await h.api<ErrorBody>("POST", "/api/workspaces", { name: "研".repeat(17) });
    expect(res.status).toBe(400);
    expect(res.json.details).toMatchObject({ field: "name", units: 34, max: 32 });
    expect(h.app.deskmates.ctx.workspaces.list().length).toBe(before);
    expect(auditCount(h, "workspace.create")).toBe(audits);
    const ok = await h.api<{ workspace: { name: string } }>("POST", "/api/workspaces", {
      name: "研".repeat(16),
    });
    expect(ok.status).toBe(201);
    expect((await h.api("POST", "/api/workspaces", { name: " padded" })).status).toBe(400);
  });

  it("rename checks the bound, keeps an unchanged legacy name and is audited", async () => {
    h = await startHarness();
    const { ctx } = h.app.deskmates;
    const ws = ctx.workspaces.create({ name: "short", sandboxProvider: "docker" });
    const legacy = "x".repeat(40);
    ctx.db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(legacy, ws.id);
    const path = `/api/workspaces/${ws.id}`;
    // The stored legacy name passes untouched with an unrelated edit.
    const same = await h.api<{ workspace: { name: string } }>("PATCH", path, {
      name: legacy,
      egressAllowlist: ["example.com"],
    });
    expect(same.status).toBe(200);
    expect(same.json.workspace.name).toBe(legacy);
    // A different over-long name is refused and nothing changes, the allowlist included.
    const refused = await h.api<ErrorBody>("PATCH", path, {
      name: "y".repeat(33),
      egressAllowlist: ["other.example"],
    });
    expect(refused.status).toBe(400);
    expect(ctx.workspaces.mustGet(ws.id).name).toBe(legacy);
    expect(ctx.workspaces.mustGet(ws.id).egressAllowlist).toEqual(["example.com"]);
    // A bad allowlist does not let the rename through either.
    const badList = await h.api("PATCH", path, { name: "ok", egressAllowlist: ["http://x/"] });
    expect(badList.status).toBe(400);
    expect(ctx.workspaces.mustGet(ws.id).name).toBe(legacy);
    const audits = auditCount(h, "workspace.update");
    const renamed = await h.api<{ workspace: { name: string } }>("PATCH", path, {
      name: "市场 research",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.workspace.name).toBe("市场 research");
    expect(auditCount(h, "workspace.update")).toBe(audits + 1);
    expect((await h.api("PATCH", path, {})).status).toBe(400);
  });
});

describe("GET /api/workspace-directory (ADR-0034 decision 3)", () => {
  it("pages with a total, refuses a limit over 100 and an unknown filter", async () => {
    h = await startHarness();
    const { ctx } = h.app.deskmates;
    for (let i = 0; i < 25; i++)
      ctx.workspaces.create({ name: `w${i}`, sandboxProvider: "docker" });
    const total = ctx.workspaces.list().length;
    const first = await h.api<WorkspaceDirectoryPage>("GET", "/api/workspace-directory");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ offset: 0, limit: 20, total });
    expect(first.json.workspaces).toHaveLength(20);
    const second = await h.api<WorkspaceDirectoryPage>(
      "GET",
      "/api/workspace-directory?offset=20&limit=20",
    );
    expect(second.json.workspaces).toHaveLength(total - 20);
    const overlap = second.json.workspaces.filter((w) =>
      first.json.workspaces.some((f) => f.id === w.id),
    );
    expect(overlap).toEqual([]);
    expect((await h.api("GET", "/api/workspace-directory?limit=101")).status).toBe(400);
    expect((await h.api("GET", "/api/workspace-directory?filter=mine")).status).toBe(400);
    expect((await h.api("GET", "/api/workspace-directory?role=root")).status).toBe(400);
    expect((await h.api("GET", `/api/workspace-directory?q=${"a".repeat(65)}`)).status).toBe(400);
    // The operator credential has no pins.
    expect((await h.api("GET", "/api/workspace-directory?filter=pinned")).status).toBe(400);
    const ws = ctx.workspaces.list()[0]?.id as WorkspaceId;
    expect((await h.api("PUT", `/api/workspaces/${ws}/pin`)).status).toBe(400);
  });

  it("a person sees only their workspaces and pins their own", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    h.app.deskmates.scheduler.stop();
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const mine = ctx.workspaces.create({ name: "mine", sandboxProvider: "docker" });
    const theirs = ctx.workspaces.create({ name: "theirs", sandboxProvider: "docker" });
    await ctx.auth.createUser({
      loginName: "mel",
      displayName: "Mel",
      password: TEST_PASSWORD,
      role: "member",
      workspaceId: mine.id,
    });
    const jar = new BrowserJar(h.baseUrl);
    expect((await jar.signIn("mel")).status).toBe(200);
    const list = await jar.json<WorkspaceDirectoryPage>("GET", "/api/workspace-directory");
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    expect(list.json.workspaces[0]).toMatchObject({ id: mine.id, myRole: "member", pinned: false });
    expect((await jar.fetch("PUT", `/api/workspaces/${theirs.id}/pin`)).status).toBe(404);
    expect((await jar.fetch("PUT", `/api/workspaces/${mine.id}/pin`)).status).toBe(200);
    const pinned = await jar.json<WorkspaceDirectoryPage>(
      "GET",
      "/api/workspace-directory?filter=pinned",
    );
    expect(pinned.json.workspaces.map((w) => [w.id, w.pinned])).toEqual([[mine.id, true]]);
    expect((await jar.fetch("DELETE", `/api/workspaces/${mine.id}/pin`)).status).toBe(200);
    const after = await jar.json<WorkspaceDirectoryPage>(
      "GET",
      "/api/workspace-directory?filter=pinned",
    );
    expect(after.json.total).toBe(0);
    // A Member does not rename (workspace.configure is Admin).
    expect(
      (await jar.fetch("PATCH", `/api/workspaces/${mine.id}`, { body: { name: "new" } })).status,
    ).toBe(403);
  });
});
