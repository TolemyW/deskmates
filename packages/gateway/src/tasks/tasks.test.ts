// T0/T1: durable operator state, workspace references and atomic optimistic concurrency.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_DIGEST_CHECK, type RunId, type WorkspaceId } from "@deskmates/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { RunStore } from "../ledger/runs.js";
import { ThreadStore } from "../threads/threads.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { TaskStore } from "./tasks.js";
import { deliverTaskInput } from "./validate.js";

let db: GatewayDb;
let store: TaskStore;
let time: Date;
let workspaceId: WorkspaceId;

function seed(database: GatewayDb, name = "one") {
  const workspace = new WorkspaceStore(database).create({ name, sandboxProvider: "docker" });
  const bot = new BotStore(database).create({ workspaceId: workspace.id, name, role: "test" });
  const thread = new ThreadStore(database).create({ workspaceId: workspace.id, botIds: [bot.id] });
  const run = new RunStore(database).create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
  });
  return { workspace, bot, thread, run };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  time = new Date("2026-10-04T00:00:00.000Z");
  store = new TaskStore(db, () => time);
  workspaceId = seed(db).workspace.id;
});
afterEach(() => db.close());

describe("workspace tasks", () => {
  it("creates planned records and lists newest changes first, with deterministic creation ties", () => {
    const a = store.create(workspaceId, { title: "  First task  " });
    const b = store.create(workspaceId, { title: "Second task" });
    expect(a).toMatchObject({
      title: "First task",
      description: "",
      ownerBotId: null,
      status: "planned",
      blockedReason: "",
      nextAction: "",
      threadIds: [],
      runIds: [],
      artifacts: [],
      version: 1,
      deliveredAt: null,
      acceptedAt: null,
      acceptedBy: null,
    });
    expect(a.createdAt).toBe(time.toISOString());
    expect(store.list(workspaceId).map((task) => task.id)).toEqual([b.id, a.id]);
    time = new Date("2026-10-04T00:01:00.000Z");
    const changed = store.update(workspaceId, a.id, { version: 1, description: "Changed" });
    expect(changed).toMatchObject({
      version: 2,
      createdAt: a.createdAt,
      updatedAt: time.toISOString(),
    });
    expect(store.list(workspaceId).map((task) => task.id)).toEqual([a.id, b.id]);
  });

  it("requires blocker details and an explicit artifact-backed delivery before acceptance", () => {
    const task = store.create(workspaceId, { title: "Ship a report" });
    for (const input of [
      { status: "blocked" },
      { status: "blocked", blockedReason: "Waiting" },
      { status: "blocked", blockedReason: " ", nextAction: "Call" },
      { status: "delivered" },
    ]) {
      expect(() =>
        store.update(workspaceId, task.id, { version: 1, title: "Must roll back", ...input }),
      ).toThrowError();
      expect(store.mustGet(workspaceId, task.id)).toEqual(task);
    }
    expect(() => store.accept(workspaceId, task.id, { version: 1 }, "human:web")).toThrowError(
      "Only a delivered task",
    );
    const blocked = store.update(workspaceId, task.id, {
      version: 1,
      status: "blocked",
      blockedReason: "Awaiting data",
      nextAction: "Ask the owner",
    });
    expect(() =>
      store.update(workspaceId, task.id, { version: blocked.version, nextAction: " " }),
    ).toThrowError("requires blockedReason");
    const delivered = store.update(workspaceId, task.id, {
      version: blocked.version,
      status: "delivered",
      artifacts: [{ label: "Report", path: "/work/report.md" }],
    });
    expect(delivered.deliveredAt).toBe(time.toISOString());
    expect(delivered.acceptedAt).toBeNull();
    expect(() =>
      store.update(workspaceId, task.id, { version: delivered.version, artifacts: [] }),
    ).toThrowError("requires at least one artifact");
    time = new Date("2026-10-04T01:00:00.000Z");
    const accepted = store.accept(
      workspaceId,
      task.id,
      { version: delivered.version },
      "human:web",
    );
    expect(accepted).toMatchObject({
      status: "accepted",
      acceptedAt: time.toISOString(),
      acceptedBy: "human:web",
      deliveredAt: delivered.deliveredAt,
      version: 4,
    });
    expect(() =>
      store.accept(workspaceId, task.id, { version: accepted.version }, "human:web"),
    ).toThrowError("Only a delivered task");
  });

  it.each(["planned", "in_progress"] as const)(
    "reopens closed records to %s, clearing delivery and acceptance",
    (status) => {
      const task = store.create(workspaceId, { title: "Report" });
      const delivered = store.update(workspaceId, task.id, {
        version: 1,
        status: "delivered",
        artifacts: [{ label: "Report", path: "/work/report.txt" }],
      });
      const accepted = store.accept(
        workspaceId,
        task.id,
        { version: delivered.version },
        "human:web",
      );
      for (const patch of [
        { title: "Alter accepted work" },
        { status: "cancelled" },
        { status: "delivered" },
        { status: "accepted" },
      ]) {
        expect(() =>
          store.update(workspaceId, task.id, { version: accepted.version, ...patch }),
        ).toThrowError();
        expect(store.mustGet(workspaceId, task.id)).toEqual(accepted);
      }
      const reopened = store.update(workspaceId, task.id, {
        version: accepted.version,
        status,
        title: "Revise report",
      });
      expect(reopened).toMatchObject({
        status,
        deliveredAt: null,
        acceptedAt: null,
        acceptedBy: null,
        title: "Revise report",
      });
      const cancelled = store.update(workspaceId, task.id, {
        version: reopened.version,
        status: "cancelled",
      });
      expect(() =>
        store.update(workspaceId, task.id, {
          version: cancelled.version,
          description: "not reopened",
        }),
      ).toThrowError("must be reopened");
      expect(() =>
        store.accept(workspaceId, task.id, { version: cancelled.version }, "human:web"),
      ).toThrowError("Only a delivered task");
      expect(
        store.update(workspaceId, task.id, { version: cancelled.version, status }),
      ).toMatchObject({ status, deliveredAt: null, acceptedAt: null, acceptedBy: null });
    },
  );

  it("clears delivery time when delivered work returns to an active state", () => {
    const task = store.create(workspaceId, { title: "Report" });
    const delivered = store.update(workspaceId, task.id, {
      version: 1,
      status: "delivered",
      artifacts: [{ label: "Report", path: "/work/report.txt" }],
    });
    const reopened = store.update(workspaceId, task.id, {
      version: delivered.version,
      status: "in_progress",
    });
    expect(reopened.deliveredAt).toBeNull();
    time = new Date("2026-10-04T02:00:00.000Z");
    expect(
      store.update(workspaceId, task.id, { version: reopened.version, status: "delivered" })
        .deliveredAt,
    ).toBe(time.toISOString());
  });

  it("refuses stale edits and acceptance without partially changing any field", () => {
    const task = store.create(workspaceId, { title: "Original" });
    const winner = store.update(workspaceId, task.id, {
      version: 1,
      title: "Winner",
      status: "delivered",
      artifacts: [{ label: "File", path: "/work/a" }],
    });
    for (const op of [
      () =>
        store.update(workspaceId, task.id, {
          version: 1,
          title: "Loser",
          ownerBotId: null,
          artifacts: [],
          runIds: [],
        }),
      () => store.accept(workspaceId, task.id, { version: 1 }, "human:web"),
    ]) {
      expect(op).toThrowError(
        expect.objectContaining({
          code: "invalid_transition",
          details: { reason: "version_conflict", expectedVersion: 1, currentVersion: 2 },
        }),
      );
      expect(store.mustGet(workspaceId, task.id)).toEqual(winner);
    }
  });

  it("checks every reference including artifact runs and ignores owner assignment as a permission", () => {
    const own = seed(db, "two");
    const colleague = new BotStore(db).create({
      workspaceId: own.workspace.id,
      name: "colleague",
      role: "writer",
    });
    const foreign = seed(db, "foreign");
    const input = {
      title: "Shared work",
      ownerBotId: own.bot.id,
      threadIds: [own.thread.id],
      runIds: [own.run.id],
      artifacts: [
        {
          label: "Colleague's current bytes",
          path: `/home/${colleague.name}/report.md`,
          runId: own.run.id,
        },
      ],
    };
    const task = store.create(own.workspace.id, input);
    expect(task.ownerBotId).toBe(own.bot.id);
    for (const patch of [
      { ownerBotId: foreign.bot.id },
      { threadIds: [foreign.thread.id] },
      { runIds: [foreign.run.id] },
      { artifacts: [{ label: "Bad source", path: "/work/a", runId: foreign.run.id }] },
      { artifacts: [{ label: "Bad home", path: `/home/${foreign.bot.name}/a` }] },
    ]) {
      expect(() =>
        store.update(own.workspace.id, task.id, { version: 1, title: "Must roll back", ...patch }),
      ).toThrowError(expect.objectContaining({ code: "forbidden" }));
      expect(store.mustGet(own.workspace.id, task.id)).toEqual(task);
      expect(() => store.create(own.workspace.id, { ...input, ...patch })).toThrowError(
        expect.objectContaining({ code: "forbidden" }),
      );
      expect(store.list(own.workspace.id)).toHaveLength(1);
    }
    expect(
      store.update(own.workspace.id, task.id, { version: 1, ownerBotId: null }).ownerBotId,
    ).toBeNull();
  });

  it("rejects unknown references, missing workspaces and wrongly scoped task access", () => {
    const other = seed(db, "other");
    const task = store.create(workspaceId, { title: "Private scope" });
    for (const input of [
      { ownerBotId: "missing" },
      { threadIds: ["missing"] },
      { runIds: ["missing"] },
      { artifacts: [{ label: "Unknown run", path: "/work/a", runId: "missing" }] },
    ]) {
      expect(() => store.create(workspaceId, { title: "Bad", ...input })).toThrowError(
        expect.objectContaining({ code: "not_found" }),
      );
    }
    for (const op of [
      () => store.mustGet(other.workspace.id, task.id),
      () => store.update(other.workspace.id, task.id, { version: 1, title: "Bad" }),
      () => store.accept(other.workspace.id, task.id, { version: 1 }, "human:web"),
      () => store.list("missing" as WorkspaceId),
      () => store.create("missing" as WorkspaceId, { title: "Bad" }),
    ])
      expect(op).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(store.mustGet(workspaceId, task.id)).toEqual(task);
  });

  it.each([
    "/profile/Cookies",
    "/etc/passwd",
    "/work/../profile/Cookies",
    "/work/a;cat",
    "/work/file with spaces",
    "/work/a，b",
    "/work/",
    "relative.md",
    "/home/unknown/file",
  ])("rejects artifact path %s before writing", (path) => {
    expect(() =>
      store.create(workspaceId, { title: "Unsafe", artifacts: [{ label: "File", path }] }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(store.list(workspaceId)).toEqual([]);
  });

  it("persists accepted records and references through database restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-tasks-restart-"));
    let persisted: GatewayDb | undefined;
    try {
      const path = join(dir, "gateway.sqlite");
      persisted = openDatabase(path);
      const source = seed(persisted);
      const tasks = new TaskStore(persisted);
      const created = tasks.create(source.workspace.id, {
        title: "Report",
        ownerBotId: source.bot.id,
        description: "Durable",
        threadIds: [source.thread.id],
        runIds: [source.run.id],
        artifacts: [{ label: "Report", path: "/work/report.txt", runId: source.run.id }],
      });
      const delivered = tasks.update(source.workspace.id, created.id, {
        version: 1,
        status: "delivered",
      });
      const accepted = tasks.accept(
        source.workspace.id,
        created.id,
        { version: delivered.version },
        "human:web",
      );
      persisted.close();
      persisted = openDatabase(path);
      expect(new TaskStore(persisted).mustGet(source.workspace.id, created.id)).toEqual(accepted);
      expect(new TaskStore(persisted).list(source.workspace.id)).toEqual([accepted]);
      expect(persisted.pragma("foreign_key_check")).toEqual([]);
    } finally {
      persisted?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bot delivery and output schemas (ADR-0021 amendment 2)", () => {
  const schema = {
    type: "object",
    required: ["total"],
    properties: { total: { type: "integer" } },
  };

  function linkedTask(extra: Record<string, unknown> = {}) {
    const source = seed(db, "deliverer");
    const task = store.create(source.workspace.id, {
      title: "Count rows",
      threadIds: [source.thread.id],
      ...extra,
    });
    return { ...source, task };
  }

  const delivery = (extra: Record<string, unknown> = {}) => ({
    taskId: "",
    summary: "Counted the rows",
    artifacts: [{ label: "Counts", path: "/work/counts.csv" }],
    ...extra,
  });

  /** The store's delivery with every artifact taken as server-verified (the route verifies). */
  function deliverRaw(runId: RunId, raw: Record<string, unknown>) {
    const input = deliverTaskInput(raw);
    const verified = new Map(
      input.artifacts.map((a) => [
        a.path,
        {
          path: a.path,
          sizeBytes: 1,
          sha256: "c".repeat(64),
          check: FILE_DIGEST_CHECK,
          checkedAt: time.toISOString(),
        },
      ]),
    );
    return store.deliver(runId, input, verified).task;
  }

  it("delivers a non-file task with no artifact and publishes nothing (A3g)", () => {
    const { workspace, run, task } = linkedTask({ outputSchema: schema });
    const delivered = deliverRaw(
      run.id,
      delivery({ taskId: task.id, artifacts: [], output: { total: 1 } }),
    );
    expect(delivered.status).toBe("delivered");
    expect(delivered.artifacts).toEqual([]);
    expect(store.deliveries(task.id)[0]).toMatchObject({ kind: "complete", publications: [] });
    expect(store.mustGet(workspace.id, task.id).status).toBe("delivered");
  });

  it("keeps a partial delivery undelivered and records what is outstanding (A3g)", () => {
    const { run, task } = linkedTask();
    const partial = deliverRaw(
      run.id,
      delivery({ taskId: task.id, outstanding: ["Illustrated report", "Version cases"] }),
    );
    expect(partial.status).toBe("in_progress");
    expect(partial.deliveredAt).toBeNull();
    expect(store.deliveries(task.id)[0]).toMatchObject({
      kind: "partial",
      outstanding: ["Illustrated report", "Version cases"],
    });
  });

  it("moves a task linked through the run's thread to delivered, recording the bot and the run", () => {
    const { workspace, bot, run, task } = linkedTask({ outputSchema: schema });
    time = new Date("2026-10-04T03:00:00.000Z");
    const delivered = deliverRaw(run.id, delivery({ taskId: task.id, output: { total: 3 } }));
    expect(delivered).toMatchObject({
      status: "delivered",
      deliveredAt: time.toISOString(),
      deliveredBy: `bot:${bot.id}`,
      output: { total: 3 },
      outputSchema: schema,
      runIds: [run.id],
      artifacts: [{ label: "Counts", path: "/work/counts.csv", runId: run.id }],
      version: 2,
      acceptedAt: null,
    });
    expect(store.mustGet(workspace.id, task.id)).toEqual(delivered);
    const accepted = store.accept(workspace.id, task.id, { version: 2 }, "human:web");
    expect(accepted).toMatchObject({ deliveredBy: `bot:${bot.id}`, output: { total: 3 } });
  });

  it("accepts a task linked by run id, merges artifacts by path and keeps the run once", () => {
    const source = seed(db, "byrun");
    const task = store.create(source.workspace.id, {
      title: "Write",
      runIds: [source.run.id],
      artifacts: [{ label: "Old", path: "/work/a.md" }],
    });
    deliverRaw(source.run.id, delivery({ taskId: task.id, output: ["any", 1] }));
    const again = deliverRaw(
      source.run.id,
      delivery({ taskId: task.id, artifacts: [{ label: "New", path: "/work/a.md" }] }),
    );
    expect(again.runIds).toEqual([source.run.id]);
    expect(again.artifacts).toEqual([
      { label: "Counts", path: "/work/counts.csv", runId: source.run.id },
      { label: "New", path: "/work/a.md", runId: source.run.id },
    ]);
    expect(again.output).toBeNull();
  });

  it("refuses an unlinked run, another workspace's task and a closed task without writing", () => {
    const { workspace, run, task } = linkedTask();
    const foreign = new RunStore(db).create({
      botId: seed(db, "elsewhere").bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "x",
    });
    const unlinked = new RunStore(db).create({
      botId: new BotStore(db).create({ workspaceId: workspace.id, name: "idle", role: "x" }).id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "x",
    });
    expect(() => deliverRaw(unlinked.id, delivery({ taskId: task.id }))).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => deliverRaw(foreign.id, delivery({ taskId: task.id }))).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(store.mustGet(workspace.id, task.id)).toEqual(task);
    const cancelled = store.update(workspace.id, task.id, { version: 1, status: "cancelled" });
    expect(() => deliverRaw(run.id, delivery({ taskId: task.id }))).toThrowError(
      expect.objectContaining({ code: "invalid_transition" }),
    );
    expect(store.mustGet(workspace.id, task.id)).toEqual(cancelled);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a repeated path",
      {
        artifacts: [
          { label: "a", path: "/work/a" },
          { label: "b", path: "/work/a" },
        ],
      },
      "validation",
    ],
    ["an unsafe path", { artifacts: [{ label: "x", path: "/etc/passwd" }] }, "forbidden"],
    ["a traversal", { artifacts: [{ label: "x", path: "/work/../profile/Cookies" }] }, "forbidden"],
    ["an empty summary", { summary: " " }, "validation"],
    ["an unknown field", { status: "accepted" }, "validation"],
    [
      "an artifact run id",
      { artifacts: [{ label: "x", path: "/work/a", runId: "r" }] },
      "validation",
    ],
    ["a schema mismatch", { output: { total: "3" } }, "validation"],
    ["a missing output under a schema", { output: undefined }, "validation"],
  ])("refuses %s without writing", (_name, extra, code) => {
    const { workspace, run, task } = linkedTask({ outputSchema: schema });
    expect(() =>
      deliverRaw(run.id, delivery({ taskId: task.id, output: { total: 1 }, ...extra })),
    ).toThrowError(expect.objectContaining({ code }));
    expect(store.mustGet(workspace.id, task.id)).toEqual(task);
  });

  it("returns every schema error to the caller", () => {
    const { run, task } = linkedTask({ outputSchema: schema });
    expect(() =>
      deliverRaw(run.id, delivery({ taskId: task.id, output: { other: 1 } })),
    ).toThrowError(
      expect.objectContaining({
        code: "validation",
        details: { errors: ["output: missing required property total"] },
      }),
    );
  });

  it("records the operator as deliverer and clears delivery facts when work reopens", () => {
    const task = store.create(workspaceId, { title: "Manual" });
    const delivered = store.update(
      workspaceId,
      task.id,
      { version: 1, status: "delivered", artifacts: [{ label: "R", path: "/work/r" }] },
      "user:usr_1",
    );
    expect(delivered.deliveredBy).toBe("user:usr_1");
    const edited = store.update(
      workspaceId,
      task.id,
      { version: 2, title: "Renamed" },
      "human:web",
    );
    expect(edited.deliveredBy).toBe("user:usr_1");
    const reopened = store.update(workspaceId, task.id, { version: 3, status: "in_progress" });
    expect(reopened).toMatchObject({ deliveredAt: null, deliveredBy: null, output: null });
  });

  it("stores, replaces and clears an output schema through operator writes", () => {
    const task = store.create(workspaceId, { title: "Typed", outputSchema: schema });
    expect(task.outputSchema).toEqual(schema);
    const cleared = store.update(workspaceId, task.id, { version: 1, outputSchema: null });
    expect(cleared.outputSchema).toBeNull();
    expect(() =>
      store.update(workspaceId, task.id, { version: 2, outputSchema: { type: "date" } }),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
    expect(() => store.create(workspaceId, { title: "Bad", outputSchema: [] })).toThrowError(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("lists open tasks linked to a run or its thread as deliverable", () => {
    const { workspace, bot, thread, run, task } = linkedTask({ outputSchema: schema });
    const byRun = store.create(workspace.id, { title: "By run", runIds: [run.id] });
    store.create(workspace.id, { title: "Unlinked" });
    const closed = store.create(workspace.id, { title: "Closed", threadIds: [thread.id] });
    store.update(workspace.id, closed.id, { version: 1, status: "cancelled" });
    expect(
      store
        .deliverableFor(run.id)
        .map((t) => t.id)
        .sort(),
    ).toEqual([task.id, byRun.id].sort());
    expect(store.deliverableFor(run.id).find((t) => t.id === task.id)).toEqual({
      id: task.id,
      title: "Count rows",
      outputSchema: schema,
      scopeVersion: 1,
    });
    const other = new RunStore(db).create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "x",
    });
    expect(store.deliverableFor(other.id)).toEqual([]);
  });
});
