import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { RunStore } from "../ledger/runs.js";
import { ThreadStore } from "../threads/threads.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { progressReports } from "./task-kind-progress.js";
import { TaskStore } from "./tasks.js";

let db: GatewayDb;
const directories: string[] = [];
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const workspace = new WorkspaceStore(db).create({ name: "evidence", sandboxProvider: "docker" });
  const bot = new BotStore(db).create({ name: "worker", role: "test", workspaceId: workspace.id });
  const thread = new ThreadStore(db).create({ workspaceId: workspace.id, botIds: [bot.id] });
  const run = new RunStore(db).create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
  });
  const tasks = new TaskStore(db);
  const task = tasks.create(workspace.id, { title: "First scope", threadIds: [thread.id] });
  const deliver = (output?: { count: number } | null) =>
    tasks.deliver(
      run.id as RunId,
      {
        taskId: task.id,
        summary: "Result",
        artifacts: [],
        ...(output === undefined ? {} : { output }),
      },
      new Map(),
    );
  return { workspace, run, tasks, task, deliver };
}

it("retains omitted schema-less output and snapshots each delivery before replacement", () => {
  const { tasks, task, deliver } = fixture();
  deliver({ count: 3 });
  const omitted = deliver();
  expect(omitted.task.output).toEqual({ count: 3 });
  deliver({ count: 7 });
  expect(tasks.deliveries(task.id)).toMatchObject([
    { output: { count: 7 } },
    { output: { count: 3 } },
    { output: { count: 3 } },
  ]);
  // A clear immediately after an output-preserving delivery must not replay that receipt.
  expect(deliver().task.output).toEqual({ count: 7 });
  expect(deliver(null).task.output).toBeNull();
  expect(tasks.deliveries(task.id)[0]).toMatchObject({ output: null });
});

it("keeps checkpoint scope attribution across edits and in continuation digests", () => {
  const { tasks, task, workspace, run } = fixture();
  const record = () =>
    tasks.recordCheckpoint(run.id, {
      taskId: task.id,
      completed: [{ unit: "Outline", outcome: "ready", evidence: ["/work/outline.md"] }],
    });
  const old = record();
  expect(old).toMatchObject({ scopeVersion: 1 });
  expect(progressReports(db, task.id)).toHaveLength(1);
  tasks.update(workspace.id, task.id, { version: 1, description: "Also include an appendix" });
  expect(progressReports(db, task.id)).toHaveLength(0);
  expect(() =>
    tasks.recordCheckpoint(run.id, { taskId: task.id, scopeVersion: 1, completed: [] }),
  ).toThrowError("The task scope changed");
  expect(tasks.latestCheckpoint(task.id)?.id).toBe(old.id);
  expect(tasks.latestCheckpoint(task.id)).toMatchObject({ id: old.id, scopeVersion: 1 });
  expect(tasks.deliverableFor(run.id)[0]).toMatchObject({
    scopeVersion: 2,
    latestCheckpoint: { scopeVersion: 1 },
  });
  expect(record()).toMatchObject({ scopeVersion: 2 });
  expect(progressReports(db, task.id)).toHaveLength(1);
});

it("persists delivery outputs across reopen without inventing historical snapshots", () => {
  db.close();
  const directory = mkdtempSync(join(tmpdir(), "deskmates-evidence-history-"));
  directories.push(directory);
  const file = join(directory, "gateway.sqlite");
  db = openDatabase(file);
  const { task, deliver } = fixture();
  const original = deliver({ count: 3 });
  deliver({ count: 7 });
  // A pre-migration row has no snapshot; current output cannot reconstruct its history.
  db.prepare("UPDATE task_deliveries SET output_json = NULL WHERE id = ?").run(
    original.delivery.id,
  );
  db.close();
  db = openDatabase(file);
  const restored = new TaskStore(db).deliveries(task.id);
  expect(restored[0]).toMatchObject({ output: { count: 7 } });
  expect(restored[1]).not.toHaveProperty("output");
});
