// T1: operator-only task lifecycle, no dispatch and strict/atomic HTTP writes.
import type { Task, WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

let sandbox: FastifyInstance;
let operator: FastifyInstance;
let provider: FakeProvider;

beforeEach(async () => {
  provider = new FakeProvider();
  sandbox = buildGateway(testConfig(), provider, { startCron: false });
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
});
afterEach(async () => {
  await operator.close();
  await sandbox.close();
});

function seed(name = "one") {
  const ctx = sandbox.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name, sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: workspace.id, name, role: "writer" });
  const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id] });
  const run = ctx.runs.create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
    config: ctx.runConfig(),
  });
  return { workspace, bot, thread, run, url: `/api/workspaces/${workspace.id}/tasks` };
}

async function api(
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: Record<string, unknown>,
) {
  return operator.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function create(url: string, extra: Record<string, unknown> = {}) {
  const response = await api("POST", url, { title: "Prepare a report", ...extra });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ task: Task }>().task;
}

describe("task operator routes", () => {
  it("creates, reads, edits, delivers and explicitly accepts without executing anything", async () => {
    const { workspace, bot, thread, run, url } = seed();
    const kick = vi.spyOn(sandbox.deskmates.scheduler, "kick");
    const ctx = sandbox.deskmates.ctx;
    const beforeRuns = ctx.db.prepare("SELECT * FROM runs").all();
    const beforeMessages = ctx.db.prepare("SELECT * FROM thread_messages").all();
    const task = await create(url, {
      ownerBotId: bot.id,
      threadIds: [thread.id],
      runIds: [run.id],
    });
    expect(task).toMatchObject({ workspaceId: workspace.id, status: "planned", version: 1 });
    expect((await api("GET", `${url}/${task.id}`)).json().task).toEqual(task);
    expect((await api("GET", url)).json()).toMatchObject({ tasks: [task], total: 1 });
    const blocked = await api("PATCH", `${url}/${task.id}`, {
      version: 1,
      status: "blocked",
      blockedReason: "Need data",
      nextAction: "Ask the operator",
    });
    expect(blocked.statusCode).toBe(200);
    const delivery = await api("PATCH", `${url}/${task.id}`, {
      version: 2,
      status: "delivered",
      artifacts: [{ label: "Report", path: "/work/report.md", runId: run.id }],
    });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json().task).toMatchObject({
      status: "delivered",
      acceptedAt: null,
      acceptedBy: null,
      version: 3,
    });
    const accepted = await api("POST", `${url}/${task.id}/accept`, { version: 3 });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().task).toMatchObject({
      status: "accepted",
      version: 4,
      acceptedBy: "human:web",
    });
    expect(typeof accepted.json().task.acceptedAt).toBe("string");
    expect(ctx.db.prepare("SELECT * FROM runs").all()).toEqual(beforeRuns);
    expect(ctx.db.prepare("SELECT * FROM thread_messages").all()).toEqual(beforeMessages);
    expect(kick).not.toHaveBeenCalled();
    expect(provider.execCalls).toEqual([]);
    expect(provider.ops).toEqual([]);
    expect(ctx.db.prepare("SELECT * FROM browser_locks").all()).toEqual([]);
  });

  it("cancelling or reopening a task leaves its linked queued and parked runs untouched", async () => {
    const { bot, run, url } = seed();
    const ctx = sandbox.deskmates.ctx;
    const parked = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "parked",
    });
    ctx.runs.transition(parked.id, "running");
    ctx.runs.transition(parked.id, "waiting_approval");
    const task = await create(url, { runIds: [run.id, parked.id] });
    const before = ctx.db.prepare("SELECT * FROM runs").all();
    const kick = vi.spyOn(sandbox.deskmates.scheduler, "kick");
    expect(
      (await api("PATCH", `${url}/${task.id}`, { version: 1, status: "cancelled" })).statusCode,
    ).toBe(200);
    expect(
      (await api("PATCH", `${url}/${task.id}`, { version: 2, status: "in_progress" })).statusCode,
    ).toBe(200);
    expect(ctx.db.prepare("SELECT * FROM runs").all()).toEqual(before);
    expect(kick).not.toHaveBeenCalled();
    expect(provider.execCalls).toEqual([]);
  });

  it("a linked run's actual lifecycle completion never delivers or accepts a task", async () => {
    const { run, url } = seed();
    const ctx = sandbox.deskmates.ctx;
    const task = await create(url, {
      runIds: [run.id],
      artifacts: [{ label: "Current output", path: "/work/result.md", runId: run.id }],
    });
    ctx.runs.transition(run.id, "running");
    sandbox.deskmates.lifecycle.ended(run.id, {
      type: "run_ended",
      runId: run.id,
      outcome: "completed",
      usage: [],
      summary: {
        done: "Finished",
        reply: "The output is ready",
        filesChanged: ["/work/result.md"],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
      },
    });
    expect(ctx.runs.mustGet(run.id).status).toBe("succeeded");
    expect((await api("GET", `${url}/${task.id}`)).json().task).toEqual(task);
  });

  it("competing writes produce one winner and 409s leave all other fields unchanged", async () => {
    const { url } = seed();
    const task = await create(url);
    const attempts = await Promise.all([
      api("PATCH", `${url}/${task.id}`, {
        version: 1,
        title: "First writer",
        description: "First data",
      }),
      api("PATCH", `${url}/${task.id}`, {
        version: 1,
        title: "Second writer",
        description: "Second data",
      }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = attempts.find((response) => response.statusCode === 200)?.json() as {
      task: Task;
    };
    expect((await api("GET", `${url}/${task.id}`)).json().task).toEqual(winner.task);
    const stale = await api("POST", `${url}/${task.id}/accept`, { version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details.reason).toBe("version_conflict");
    expect((await api("GET", `${url}/${task.id}`)).json().task).toEqual(winner.task);
  });

  it("rejects malformed, unknown, terminal, and spoofed-acceptance writes atomically", async () => {
    const { url } = seed();
    const task = await create(url);
    for (const patch of [
      { version: 1, title: "Changed", status: "blocked" },
      { version: 1, title: "Changed", status: "delivered" },
      { version: 1, status: "accepted" },
      { version: 1, workspaceId: "other" },
      { title: "No version" },
      { version: 1, title: "x".repeat(201) },
      { version: 1, artifacts: [{ label: "Wrong", path: "/work/a", extra: true }] },
    ]) {
      const response = await api("PATCH", `${url}/${task.id}`, patch);
      expect(response.statusCode, JSON.stringify(patch)).toBe(400);
      expect(response.json().code).toBe("validation");
      expect((await api("GET", `${url}/${task.id}`)).json().task).toEqual(task);
    }
    for (const body of [
      { version: 1, authorId: "someone" },
      { version: 1, acceptedBy: "human:alice" },
      {},
    ])
      expect((await api("POST", `${url}/${task.id}/accept`, body)).statusCode).toBe(400);
    expect((await api("POST", `${url}/${task.id}/accept`, { version: 1 })).statusCode).toBe(409);
    expect(
      (await api("PATCH", `${url}/${task.id}`, { version: 1, status: "cancelled" })).statusCode,
    ).toBe(200);
    expect(
      (await api("PATCH", `${url}/${task.id}`, { version: 2, title: "Closed edit" })).statusCode,
    ).toBe(409);
    const reopened = await api("PATCH", `${url}/${task.id}`, { version: 2, status: "planned" });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().task).toMatchObject({
      status: "planned",
      deliveredAt: null,
      acceptedAt: null,
      acceptedBy: null,
    });
  });

  it("rejects foreign and unknown references with no partial update or create", async () => {
    const own = seed();
    const foreign = seed("foreign");
    const task = await create(own.url);
    const cases: [Record<string, unknown>, number][] = [
      [{ ownerBotId: foreign.bot.id }, 403],
      [{ threadIds: [foreign.thread.id] }, 403],
      [{ runIds: [foreign.run.id] }, 403],
      [{ artifacts: [{ label: "File", path: "/work/a", runId: foreign.run.id }] }, 403],
      [{ artifacts: [{ label: "Home", path: `/home/${foreign.bot.name}/a` }] }, 403],
      [{ ownerBotId: "missing" }, 404],
      [{ threadIds: ["missing"] }, 404],
      [{ runIds: ["missing"] }, 404],
      [{ artifacts: [{ label: "File", path: "/work/a", runId: "missing" }] }, 404],
    ];
    for (const [patch, status] of cases) {
      expect(
        (await api("PATCH", `${own.url}/${task.id}`, { version: 1, title: "Changed", ...patch }))
          .statusCode,
      ).toBe(status);
      expect((await api("POST", own.url, { title: "Invalid", ...patch })).statusCode).toBe(status);
      expect((await api("GET", `${own.url}/${task.id}`)).json().task).toEqual(task);
    }
    expect((await api("GET", own.url)).json()).toMatchObject({ tasks: [task], total: 1 });
    expect((await api("GET", foreign.url)).json()).toMatchObject({ tasks: [], total: 0 });
    expect((await api("GET", `${foreign.url}/${task.id}`)).statusCode).toBe(404);
    expect(
      (await api("PATCH", `${foreign.url}/${task.id}`, { version: 1, title: "Wrong workspace" }))
        .statusCode,
    ).toBe(404);
    expect((await api("POST", `${foreign.url}/${task.id}/accept`, { version: 1 })).statusCode).toBe(
      404,
    );
    expect((await api("GET", "/api/workspaces/missing/tasks")).statusCode).toBe(404);
  });

  it("every task endpoint requires the operator credential and is absent from the sandbox listener", async () => {
    const { workspace, run, url } = seed();
    const task = await create(url);
    const token = sandbox.deskmates.ctx.tokens.issue(run.id).token;
    const endpoints: ["GET" | "POST" | "PATCH", string, Record<string, unknown>?][] = [
      ["GET", url],
      ["POST", url, { title: "New" }],
      ["GET", `${url}/${task.id}`],
      ["PATCH", `${url}/${task.id}`, { version: 1, title: "Changed" }],
      ["POST", `${url}/${task.id}/accept`, { version: 1 }],
    ];
    for (const [method, path, payload] of endpoints) {
      for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
        const response = await operator.inject({
          method,
          url: path,
          headers,
          ...(payload === undefined ? {} : { payload }),
        });
        expect(response.statusCode, `${method} ${path}`).toBe(401);
      }
      for (const credential of [token, TEST_OPERATOR_TOKEN]) {
        const response = await sandbox.inject({
          method,
          url: path,
          headers: { authorization: `Bearer ${credential}` },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(response.statusCode, `${method} ${path}`).toBe(404);
      }
    }
    expect(
      (
        await sandbox.inject({
          method: "POST",
          url: `/internal/runs/${run.id}/tasks`,
          headers: { authorization: `Bearer ${token}` },
          payload: { title: "Bot task" },
        })
      ).statusCode,
    ).toBe(404);
    expect(sandbox.deskmates.ctx.tasks.mustGet(workspace.id as WorkspaceId, task.id)).toEqual(task);
  });
});
