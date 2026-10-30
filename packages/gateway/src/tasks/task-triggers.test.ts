// T1 (ADR-0021 amendment 3, A3a to A3c, A3e, A3k to A3m): explicit task triggers through the
// operator listener. An immediate create or the Run action writes one keyed submission and posts
// one must-reply message through the router; everything else dispatches nothing.
import type {
  Task,
  TaskDetailResponse,
  TaskSubmission,
  TaskSubmitResponse,
} from "@deskmates/contracts";
import { FILE_DIGEST_CHECK } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

let sandbox: FastifyInstance;
let operator: FastifyInstance;

beforeEach(async () => {
  sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
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
  return { ctx, workspace, bot, url: `/api/workspaces/${workspace.id}/tasks` };
}

function api(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return operator.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const count = (table: string): number =>
  (
    sandbox.deskmates.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;

const audits = (action: string) =>
  sandbox.deskmates.ctx.db
    .prepare("SELECT actor, target_id FROM audit_events WHERE action = ?")
    .all(action) as Array<{ actor: string; target_id: string }>;

describe("explicit task triggers (ADR-0021 amendment 3)", () => {
  it("reopens a delivery and sends revision feedback once, preserving its earlier publication", async () => {
    const { ctx, bot, workspace, url } = seed();
    const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id] });
    const task = ctx.tasks.create(workspace.id, {
      title: "Report",
      ownerBotId: bot.id,
      threadIds: [thread.id],
    });
    const run = ctx.runs.create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "manual",
      triggerRef: "first-delivery",
    });
    const original = ctx.tasks.deliver(
      run.id,
      {
        taskId: task.id,
        summary: "First report",
        artifacts: [{ label: "Report", path: "/work/report.md" }],
      },
      new Map([
        [
          "/work/report.md",
          {
            path: "/work/report.md",
            sizeBytes: 8,
            sha256: "c".repeat(64),
            check: FILE_DIGEST_CHECK,
            checkedAt: new Date().toISOString(),
          },
        ],
      ]),
    );
    const delivered = original.task;
    ctx.runs.transition(run.id, "running");
    ctx.runs.transition(run.id, "succeeded");
    const request = {
      version: delivered.version,
      idempotencyKey: "revision-key-01",
      feedback: "Add sources and explain the missing period.",
    };
    const first = await api("POST", `${url}/${task.id}/run`, request);
    expect(first.statusCode, first.body).toBe(201);
    const result = first.json<TaskSubmitResponse>();
    expect(result.task.status).toBe("in_progress");
    expect(result.task.scopeVersion).toBe(delivered.scopeVersion + 1);
    expect(() =>
      ctx.tasks.deliveryScope(run.id, {
        taskId: task.id,
        scopeVersion: delivered.scopeVersion,
        summary: "Late original result",
        artifacts: [],
      }),
    ).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: "stale_scope" }) }),
    );
    expect(result.submission?.runs).toHaveLength(1);
    const message = ctx.messages.get(result.submission?.messageId as never);
    expect(message?.body).toContain(request.feedback);
    expect(message?.body).toContain("Preserve earlier delivery evidence");
    const retry = await api("POST", `${url}/${task.id}/run`, request);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().submission.id).toBe(result.submission?.id);
    expect(count("task_submissions")).toBe(1);
    expect(audits("task.run")).toHaveLength(1);
    const after = (await api("GET", `${url}/${task.id}`)).json<TaskDetailResponse>();
    expect(after.execution.deliveries[0]).toMatchObject({
      id: original.delivery.id,
      summary: "First report",
      publications: [expect.objectContaining({ path: "/work/report.md", sha256: "c".repeat(64) })],
    });
    // A new feedback request may not restart work that has already left delivered.
    expect(
      (
        await api("POST", `${url}/${task.id}/run`, {
          ...request,
          version: result.task.version,
          idempotencyKey: "revision-key-02",
        })
      ).statusCode,
    ).toBe(409);
  });

  it("keeps delivery intact when revision dispatch fails and refuses empty feedback", async () => {
    const { ctx, workspace, url } = seed();
    const task = ctx.tasks.create(workspace.id, {
      title: "Unassigned",
      artifacts: [{ label: "Report", path: "/work/report.md" }],
    });
    const delivered = ctx.tasks.update(
      workspace.id,
      task.id,
      { version: task.version, status: "delivered" },
      "human:web",
    );
    const input = {
      version: delivered.version,
      idempotencyKey: "revision-key-01",
      feedback: "Fix the figures",
    };
    expect((await api("POST", `${url}/${task.id}/run`, input)).statusCode).toBe(400);
    expect(ctx.tasks.mustGet(workspace.id, task.id)).toMatchObject({
      status: "delivered",
      version: delivered.version,
    });
    expect(count("task_submissions")).toBe(0);
    expect(
      (await api("POST", `${url}/${task.id}/run`, { ...input, feedback: " " })).statusCode,
    ).toBe(400);
  });
  it("dispatches an immediate create through the router: one submission, one queued run", async () => {
    const { ctx, bot, url } = seed();
    const response = await api("POST", url, {
      title: "Weekly digest",
      description: "Summarise the week",
      ownerBotId: bot.id,
      trigger: "immediate",
      idempotencyKey: "create-key-0001",
    });
    expect(response.statusCode, response.body).toBe(201);
    const { task, submission } = response.json<TaskSubmitResponse>();
    expect(submission).toMatchObject({
      kind: "immediate",
      key: "create:create-key-0001",
      dispatch: "posted",
      actor: "human:web",
      scopeVersion: 1,
      state: "queued",
    });
    const sub = submission as TaskSubmission;
    expect(sub.runs).toHaveLength(1);
    expect(task.threadIds).toEqual([sub.threadId]);
    expect(task.runIds).toEqual([sub.runs[0]?.id]);
    const message = ctx.messages.first(sub.threadId as never);
    expect(message).toMatchObject({ authorKind: "human", mustReply: true });
    expect(message?.body).toContain(`@one Please work on task "Weekly digest" (task ${task.id}`);
    expect(message?.body).toContain("Summarise the week");
    expect(ctx.threads.members(sub.threadId as never).map((m) => m.botId)).toEqual([bot.id]);
    expect(audits("task.run")).toEqual([{ actor: "human:web", target_id: task.id }]);
    // Run success is not task completion: the declared state is still planned.
    expect(task.status).toBe("planned");
  });

  it("is idempotent on the create key and the Run key; a new Run key is a new execution", async () => {
    const { bot, url } = seed();
    const payload = {
      title: "Once",
      ownerBotId: bot.id,
      trigger: "immediate",
      idempotencyKey: "same-key-0001",
    };
    const first = await api("POST", url, payload);
    const counts = () => [count("tasks"), count("task_submissions"), count("thread_messages")];
    const before = counts();
    const again = await api("POST", url, payload);
    expect(again.statusCode).toBe(200);
    expect(again.json().task.id).toBe(first.json().task.id);
    expect(again.json().submission.id).toBe(first.json().submission.id);
    expect(counts()).toEqual(before);

    const task = again.json<TaskSubmitResponse>().task;
    const run = { version: task.version, idempotencyKey: "run-key-00001" };
    const ran = await api("POST", `${url}/${task.id}/run`, run);
    expect(ran.statusCode, ran.body).toBe(201);
    // The lost-response retry carries the same key and an outdated version: same submission.
    const retry = await api("POST", `${url}/${task.id}/run`, run);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().submission.id).toBe(ran.json().submission.id);
    const later = await api("POST", `${url}/${task.id}/run`, {
      version: ran.json().task.version,
      idempotencyKey: "run-key-00002",
    });
    expect(later.statusCode).toBe(201);
    expect(count("task_submissions")).toBe(3);
    const stale = await api("POST", `${url}/${task.id}/run`, {
      version: 1,
      idempotencyKey: "run-key-00003",
    });
    expect(stale.statusCode).toBe(409);
  });

  it("dispatches nothing for scheduled, manual or trigger-less creates, or for edits", async () => {
    const { bot, url } = seed();
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await api("POST", url, {
      title: "Later",
      ownerBotId: bot.id,
      trigger: "scheduled",
      schedule: { kind: "once", runAt, timeZone: "Europe/Berlin" },
    });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    expect(scheduled.json().task.schedule).toMatchObject({
      kind: "once",
      runAt,
      timeZone: "Europe/Berlin",
      nextFireAt: runAt,
      enabled: true,
    });
    expect(scheduled.json().submission).toBeUndefined();
    const manual = await api("POST", url, {
      title: "By hand",
      ownerBotId: bot.id,
      trigger: "manual",
    });
    const plain = await api("POST", url, { title: "Record only" });
    expect([manual.statusCode, plain.statusCode]).toEqual([201, 201]);
    const task = manual.json<TaskSubmitResponse>().task;
    const edited = await api("PATCH", `${url}/${task.id}`, {
      version: task.version,
      description: "Edited",
      schedule: { kind: "repeat", cron: "0 9 * * 1", timeZone: "Asia/Shanghai" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().task.schedule).toMatchObject({ kind: "repeat", version: 1 });
    expect(audits("task.schedule_set")).toHaveLength(2);
    expect([count("runs"), count("thread_messages"), count("task_submissions")]).toEqual([0, 0, 0]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["immediate without an owner", { trigger: "immediate" }],
    ["scheduled without a schedule", { trigger: "scheduled", ownerBotId: "owner" }],
    ["a schedule on a manual task", { trigger: "manual", schedule: { kind: "once", runAt: "x" } }],
    ["an unknown trigger", { trigger: "draft" }],
    ["a short key", { idempotencyKey: "short" }],
    [
      "a past one-time schedule",
      {
        trigger: "scheduled",
        ownerBotId: "owner",
        schedule: { kind: "once", runAt: "2020-01-01T00:00:00Z" },
      },
    ],
    [
      "a bad time zone",
      {
        trigger: "scheduled",
        ownerBotId: "owner",
        schedule: { kind: "repeat", cron: "* * * * *", timeZone: "Mars/Base" },
      },
    ],
  ])("refuses %s without writing", async (_name, extra) => {
    const { bot, url } = seed();
    const payload: Record<string, unknown> = { title: "x", ...extra };
    if (payload.ownerBotId === "owner") payload.ownerBotId = bot.id;
    const response = await api("POST", url, payload);
    expect(response.statusCode, response.body).toBe(400);
    expect([count("tasks"), count("task_submissions"), count("runs")]).toEqual([0, 0, 0]);
  });

  it("refuses Run on a closed task and on a task without an owner", async () => {
    const { url } = seed();
    const created = await api("POST", url, { title: "Nobody" });
    const task = created.json<TaskSubmitResponse>().task;
    const ownerless = await api("POST", `${url}/${task.id}/run`, {
      version: 1,
      idempotencyKey: "run-key-00001",
    });
    expect(ownerless.statusCode).toBe(400);
    const cancelled = await api("PATCH", `${url}/${task.id}`, { version: 1, status: "cancelled" });
    const closed = await api("POST", `${url}/${task.id}/run`, {
      version: cancelled.json().task.version,
      idempotencyKey: "run-key-00002",
    });
    expect(closed.statusCode).toBe(409);
    expect(count("task_submissions")).toBe(0);
  });

  it("reports execution beside the declared state, with Gateway times", async () => {
    const { bot, url } = seed();
    const created = await api("POST", url, {
      title: "Watch",
      ownerBotId: bot.id,
      trigger: "immediate",
    });
    const task = created.json<TaskSubmitResponse>().task;
    const detail = (await api("GET", `${url}/${task.id}`)).json<TaskDetailResponse>();
    expect(detail.task.status).toBe("planned");
    expect(Date.parse(detail.execution.observedAt)).not.toBeNaN();
    expect(detail.execution.submissions).toHaveLength(1);
    expect(detail.execution.submissions[0]?.runs[0]).toMatchObject({
      status: "queued",
      botId: bot.id,
      pendingApprovals: 0,
      startedAt: null,
    });
    expect(detail.execution.linkedRuns.map((r) => r.id)).toEqual(task.runIds);
    expect(detail.execution.deliveries).toEqual([]);
    expect(detail.execution.latestCheckpoint).toBeNull();
  });

  it("deletes softly: future triggers stop, history and runs stay", async () => {
    const { ctx, bot, url } = seed();
    const created = await api("POST", url, {
      title: "Recurring",
      ownerBotId: bot.id,
      trigger: "immediate",
    });
    const task: Task = created.json<TaskSubmitResponse>().task;
    await api("PATCH", `${url}/${task.id}`, {
      version: task.version,
      schedule: { kind: "repeat", cron: "*/5 * * * *" },
    });
    const current = ctx.tasks.mustGet(task.workspaceId, task.id);
    const stale = await api("DELETE", `${url}/${task.id}`, { version: 1 });
    expect(stale.statusCode).toBe(409);
    const deleted = await api("DELETE", `${url}/${task.id}`, { version: current.version });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await api("GET", url)).json().tasks).toEqual([]);
    expect((await api("GET", `${url}/${task.id}`)).statusCode).toBe(404);
    const run = await api("POST", `${url}/${task.id}/run`, {
      version: current.version + 1,
      idempotencyKey: "run-after-delete",
    });
    expect(run.statusCode).toBe(404);
    expect(count("tasks")).toBe(1);
    expect(count("runs")).toBe(1);
    expect(count("task_submissions")).toBe(1);
    expect(ctx.tasks.schedules.due(new Date(Date.now() + 86_400_000))).toEqual([]);
    expect(ctx.tasks.deliverableFor(task.runIds[0] as never)).toEqual([]);
    expect(audits("task.delete")).toEqual([{ actor: "human:web", target_id: task.id }]);
  });
});
