// T1: the workspace message board (ADR-0022 amendment 6 W10, ADR-0031 decision 10). Every
// current member posts and reads, Guests included; the author edits and withdraws; an Admin or
// Owner hides and unhides; a post is inert, whatever it mentions; pages follow the cursor.

import type { BoardPageView, BoardPostView } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const count = (harness: Harness, table: string) =>
  (
    harness.app.deskmates.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;

describe("message board (ADR-0022 amendment 6 W10)", () => {
  it("a Guest posts, everyone reads, the author edits and withdraws, a moderator hides", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const people = await seedRoles(harness);
    const board = `/api/workspaces/${people.workspace.id}/board`;
    const before = { runs: count(harness, "runs"), tasks: count(harness, "tasks") };

    const posted = await people.guest.json<{ post: BoardPostView }>("POST", board, {
      body: { body: "@helper @everyone please restart the server", clientRequestId: "req-1" },
    });
    expect(posted.status).toBe(201);
    const post = posted.json.post;
    expect(post).toMatchObject({ author: `user:${people.ids.gus}`, state: "visible", mine: true });
    // A repeated submission returns the first post.
    const repeat = await people.guest.json<{ post: BoardPostView }>("POST", board, {
      body: { body: "@helper @everyone please restart the server", clientRequestId: "req-1" },
    });
    expect(repeat.json.post.id).toBe(post.id);
    // Inert: no run, task or approval from a post, whatever it mentions.
    expect(count(harness, "runs")).toBe(before.runs);
    expect(count(harness, "tasks")).toBe(before.tasks);
    expect(count(harness, "approvals")).toBe(0);

    const read = await people.member.json<BoardPageView>("GET", board);
    expect(read.status).toBe(200);
    expect(read.json.posts.map((p) => p.id)).toEqual([post.id]);
    expect(read.json.posts[0]?.mine).toBe(false);
    expect(read.json.canModerate).toBe(false);

    // Only the author edits and withdraws.
    expect(
      (await people.member.fetch("PATCH", `${board}/${post.id}`, { body: { body: "mine now" } }))
        .status,
    ).toBe(403);
    const edited = await people.guest.json<{ post: BoardPostView }>(
      "PATCH",
      `${board}/${post.id}`,
      { body: { body: "please restart the server tonight" } },
    );
    expect(edited.json.post).toMatchObject({
      body: "please restart the server tonight",
      version: 2,
    });

    // A Member cannot moderate; an Admin hides and unhides, and still sees the hidden post.
    expect(
      (
        await people.member.fetch("POST", `${board}/${post.id}/moderate`, {
          body: { hidden: true },
        })
      ).status,
    ).toBe(403);
    const hidden = await people.admin.json<{ post: BoardPostView }>(
      "POST",
      `${board}/${post.id}/moderate`,
      { body: { hidden: true, reason: "off topic" } },
    );
    expect(hidden.json.post.state).toBe("hidden");
    expect((await people.member.json<BoardPageView>("GET", board)).json.posts).toEqual([]);
    const moderatorView = await people.admin.json<BoardPageView>("GET", board);
    expect(moderatorView.json.canModerate).toBe(true);
    expect(moderatorView.json.posts.map((p) => p.state)).toEqual(["hidden"]);
    await people.owner.fetch("POST", `${board}/${post.id}/moderate`, { body: { hidden: false } });
    expect((await people.member.json<BoardPageView>("GET", board)).json.posts).toHaveLength(1);

    // History: the author and moderators, nobody else.
    const history = await people.guest.json<{ versions: Array<{ op: string }> }>(
      "GET",
      `${board}/${post.id}/history`,
    );
    expect(history.json.versions.map((v) => v.op)).toEqual(["post", "edit", "hide", "unhide"]);
    expect((await people.member.fetch("GET", `${board}/${post.id}/history`)).status).toBe(404);

    const withdrawn = await people.guest.json<{ post: BoardPostView }>(
      "POST",
      `${board}/${post.id}/withdraw`,
    );
    expect(withdrawn.json.post.state).toBe("withdrawn");
    expect((await people.admin.json<BoardPageView>("GET", board)).json.posts).toEqual([]);
  });

  it("pages newest first with a cursor, and another workspace's post is not found", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const people = await seedRoles(harness);
    const board = `/api/workspaces/${people.workspace.id}/board`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        (
          await people.member.json<{ post: BoardPostView }>("POST", board, {
            body: { body: `post ${i}` },
          })
        ).json.post.id,
      );
    const first = await people.guest.json<BoardPageView>("GET", `${board}?limit=2`);
    expect(first.json.posts.map((p) => p.body)).toEqual(["post 4", "post 3"]);
    expect(first.json.nextCursor).toBeDefined();
    const second = await people.guest.json<BoardPageView>(
      "GET",
      `${board}?limit=2&before=${first.json.nextCursor}`,
    );
    expect(second.json.posts.map((p) => p.body)).toEqual(["post 2", "post 1"]);
    const last = await people.guest.json<BoardPageView>(
      "GET",
      `${board}?limit=2&before=${second.json.nextCursor}`,
    );
    expect(last.json.posts.map((p) => p.body)).toEqual(["post 0"]);
    expect(last.json.nextCursor).toBeUndefined();

    const { ctx } = harness.app.deskmates;
    const other = ctx.workspaces.create({ name: "Other", sandboxProvider: "docker" });
    // Mel does not belong to the other workspace: its board is not found.
    expect((await people.member.fetch("GET", `/api/workspaces/${other.id}/board`)).status).toBe(
      404,
    );
    // A post id used under another workspace is not found either.
    const rootView = await people.root.fetch(
      "PATCH",
      `/api/workspaces/${other.id}/board/${ids[0]}`,
      { body: { body: "moved" } },
    );
    expect(rootView.status).toBe(404);
  });
});
