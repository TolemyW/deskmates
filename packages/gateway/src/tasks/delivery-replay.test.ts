import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDeliverRequest } from "@deskmates/contracts";
import { expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { openDatabase } from "../db/open.js";
import { RunStore } from "../ledger/runs.js";
import { ThreadStore } from "../threads/threads.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { TaskStore } from "./tasks.js";

it("replays a key-reordered non-file delivery after database reopen without losing history", () => {
  const folder = mkdtempSync(join(tmpdir(), "deskmates-delivery-replay-"));
  const path = join(folder, "gateway.sqlite");
  let db = openDatabase(path);
  try {
    const workspace = new WorkspaceStore(db).create({ name: "replay", sandboxProvider: "docker" });
    const bot = new BotStore(db).create({
      workspaceId: workspace.id,
      name: "writer",
      role: "test",
    });
    const thread = new ThreadStore(db).create({ workspaceId: workspace.id, botIds: [bot.id] });
    const run = new RunStore(db).create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
    });
    const store = new TaskStore(db);
    const task = store.create(workspace.id, {
      title: "A structured result",
      threadIds: [thread.id],
    });
    const input: TaskDeliverRequest = {
      taskId: task.id,
      summary: "result",
      artifacts: [],
      output: { b: { x: 1, y: 2 }, a: [3, 4] },
    };
    const first = store.deliver(run.id, input, new Map());
    expect(first.replayed).toBe(false);
    db.close();
    db = openDatabase(path);
    const reopened = new TaskStore(db);
    const retry = reopened.deliver(
      run.id,
      { ...input, output: { a: [3, 4], b: { y: 2, x: 1 } } },
      new Map(),
    );
    expect(retry.replayed).toBe(true);
    expect(retry.task).toEqual(first.task);
    expect(retry.delivery).toEqual(first.delivery);
    expect(reopened.deliveries(task.id)).toHaveLength(1);

    // A historical row has no replay identity. Keep it; never infer that it was a retry.
    db.prepare("UPDATE task_deliveries SET request_sha256 = NULL, task_version = NULL").run();
    const historical = reopened.deliveries(task.id);
    const next = reopened.deliver(run.id, input, new Map());
    expect(next.replayed).toBe(false);
    expect(reopened.deliveries(task.id)).toContainEqual(historical[0]);
    expect(reopened.deliver(run.id, input, new Map()).replayed).toBe(true);
    expect(reopened.deliveries(task.id)).toHaveLength(2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
