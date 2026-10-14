// T1: the workspace message board (ADR-0031 decision 10). Posts are inert; edit, withdraw and
// hide each add an immutable version; a repeated client request id returns the first post.

import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../auth/auth-service.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { BoardStore } from "./board-store.js";

let db: GatewayDb;
let board: BoardStore;
let workspaceId: string;
let author: string;
let moderator: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const auth = new AuthService(db, { passwordMinLength: 8 });
  workspaceId = new WorkspaceStore(db).create({ name: "W", sandboxProvider: "docker" }).id;
  const make = async (loginName: string, role: "owner" | "member") =>
    (
      await auth.createUser({
        loginName,
        displayName: loginName,
        password: "correct horse battery staple",
        role,
        workspaceId,
      })
    ).id;
  author = await make("guest-author", "member");
  moderator = await make("moderator", "owner");
  board = new BoardStore(db);
});

function count(table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("workspace message board (ADR-0031 decision 10)", () => {
  it("records every change as a version and never starts a run", () => {
    const post = board.post({ workspaceId, authorUserId: author, body: "@everyone hello bot" });
    expect(post).toMatchObject({ state: "visible", version: 1 });
    board.edit(workspaceId, post.id, author, "hello, edited");
    board.moderate(workspaceId, post.id, moderator, true, "off topic");
    expect(board.list(workspaceId)).toEqual([]);
    board.moderate(workspaceId, post.id, moderator, false);
    board.withdraw(workspaceId, post.id, author);
    expect(board.history(post.id).map((v) => [v.version, v.op, v.state])).toEqual([
      [1, "post", "visible"],
      [2, "edit", "visible"],
      [3, "hide", "hidden"],
      [4, "unhide", "visible"],
      [5, "withdraw", "withdrawn"],
    ]);
    expect(board.history(post.id)[0]?.body).toBe("@everyone hello bot");
    expect(count("runs")).toBe(0);
    expect(count("tasks")).toBe(0);
    expect(count("approvals")).toBe(0);
    expect(count("memory_suggestions")).toBe(0);
  });

  it("refuses edits by anyone but the author, and keeps versions immutable", () => {
    const post = board.post({ workspaceId, authorUserId: author, body: "mine" });
    expect(() => board.edit(workspaceId, post.id, moderator, "not mine")).toThrow(/author/);
    expect(() => db.prepare("UPDATE board_post_versions SET body = 'x'").run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare("DELETE FROM board_post_versions").run()).toThrow(/immutable/);
  });

  it("returns the first post for a repeated client request id", () => {
    const first = board.post({
      workspaceId,
      authorUserId: author,
      body: "once",
      clientRequestId: "req-1",
    });
    const again = board.post({
      workspaceId,
      authorUserId: author,
      body: "once",
      clientRequestId: "req-1",
    });
    expect(again.id).toBe(first.id);
    expect(count("board_posts")).toBe(1);
  });
});
