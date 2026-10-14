// T1: the Tasks list pages on the server (#113, pagination coverage surface 22). One offset page
// at a time, most recently updated first with the insertion order as tie-breaker, status and
// search applied before paging, an honest total under the filter, and counts by status over the
// whole workspace so the metric cards never count a page. A bad limit, offset or status is 400.

import type { TaskListPage, Workspace } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const AT = "2026-10-14T00:00:00.000Z";

function seed(): { workspace: Workspace; url: string; ids: string[] } {
  const ctx = h.app.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name: "tasks", sandboxProvider: "docker" });
  const writer = ctx.bots.create({ workspaceId: workspace.id, name: "Writer", role: "writer" });
  const ids: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const task = ctx.tasks.create(workspace.id, {
      title: i === 3 ? "Quarterly 50%_report" : `Task ${i}`,
      ...(i === 5 ? { ownerBotId: writer.id } : {}),
    });
    ids.push(task.id);
  }
  // Equal update times: the insertion order decides, newest first.
  ctx.db.prepare("UPDATE tasks SET updated_at = ? WHERE workspace_id = ?").run(AT, workspace.id);
  ctx.db
    .prepare(
      "UPDATE tasks SET status = 'blocked', blocked_reason = 'x', next_action = 'y' WHERE id = ?",
    )
    .run(ids[1]);
  ctx.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(ids[2]);
  // Another workspace's tasks never show up or count.
  const other = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
  ctx.tasks.create(other.id, { title: "Task elsewhere" });
  return { workspace, url: `/api/workspaces/${workspace.id}/tasks`, ids };
}

describe("Tasks page (#113)", () => {
  it("pages newest first with a stable tie-breaker, an honest total and whole-workspace counts", async () => {
    const { url, ids } = seed();
    const seen: string[] = [];
    for (const offset of [0, 3, 6]) {
      const page = (await h.api<TaskListPage>("GET", `${url}?offset=${offset}&limit=3`)).json;
      expect(page).toMatchObject({ offset, limit: 3, total: 7 });
      expect(page.statusCounts).toEqual({
        planned: 5,
        in_progress: 0,
        blocked: 1,
        delivered: 0,
        accepted: 0,
        cancelled: 1,
      });
      seen.push(...page.tasks.map((task) => task.id));
    }
    expect(seen).toEqual([...ids].reverse());
    const past = (await h.api<TaskListPage>("GET", `${url}?offset=9&limit=3`)).json;
    expect(past).toMatchObject({ tasks: [], total: 7 });
    // An unpaged request gets the first page, never the whole collection.
    expect((await h.api<TaskListPage>("GET", url)).json).toMatchObject({ offset: 0, limit: 25 });
  });

  it("filters by status and searches title and owner on the server before paging", async () => {
    const { url, ids } = seed();
    const blocked = (await h.api<TaskListPage>("GET", `${url}?status=blocked`)).json;
    expect(blocked.tasks.map((task) => task.id)).toEqual([ids[1]]);
    expect(blocked.total).toBe(1);
    // The counts stay the workspace's, whatever the filter.
    expect(blocked.statusCounts.planned).toBe(5);
    const byOwner = (await h.api<TaskListPage>("GET", `${url}?q=writer`)).json;
    expect(byOwner.tasks.map((task) => task.id)).toEqual([ids[5]]);
    // LIKE wildcards in the search are literal.
    const literal = (await h.api<TaskListPage>("GET", `${url}?q=${encodeURIComponent("50%_")}`))
      .json;
    expect(literal.tasks.map((task) => task.id)).toEqual([ids[3]]);
    expect((await h.api<TaskListPage>("GET", `${url}?q=%25`)).json.total).toBe(1);
    const both = (await h.api<TaskListPage>("GET", `${url}?status=planned&q=task&limit=2`)).json;
    expect(both).toMatchObject({ total: 4, limit: 2 });
    expect(both.tasks.map((task) => task.id)).toEqual([ids[6], ids[5]]);
  });

  it("refuses a limit over the maximum, a bad offset and an unknown status", async () => {
    const { url } = seed();
    expect((await h.api("GET", `${url}?limit=101`)).status).toBe(400);
    expect((await h.api("GET", `${url}?limit=0`)).status).toBe(400);
    expect((await h.api("GET", `${url}?offset=-1`)).status).toBe(400);
    expect((await h.api("GET", `${url}?status=done`)).status).toBe(400);
  });
});
