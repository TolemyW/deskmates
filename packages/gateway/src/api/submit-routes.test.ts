// T1: the composite submit (issue #21, part 4). One call creates a one-member chat thread bound to
// `(agent:<caller>, externalKey)`, a planned task linked to it, and the instruction as a
// must-reply human message that wakes the bot through the normal router. A repeated key returns
// the existing ids and writes nothing; a refused submit writes nothing; a service principal is
// attributed and budgeted as on the message route; another tenant's ids are the uniform 404.

import {
  type BotId,
  CSRF_HEADER,
  RUN_ERROR_NO_REPLY,
  type RunEnded,
  type RunId,
  type SubmissionResponse,
  type SubmitResponse,
  type WorkspaceId,
  agentChannel,
} from "@deskmates/contracts";
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import type { RunRecord } from "../ledger/runs.js";
import {
  type Harness,
  TEST_OPERATOR_TOKEN,
  startHarness,
  waitFor,
} from "../test-support/harness.js";
import { seedTenant, snapshotDatabase } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";
const DENIAL = { code: "not_found", message: "Not found", details: {} };

let h: Harness;

beforeEach(async () => {
  h = await startHarness({
    secretsKey: Buffer.alloc(32, 7).toString("base64"),
    auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
  });
});

afterEach(async () => {
  await h.close();
});

type Caller = { bearer: string } | { token: string; csrf: string };

function call(who: Caller, method: string, url: string, payload?: unknown) {
  const headers: Record<string, string> =
    "bearer" in who
      ? { authorization: `Bearer ${who.bearer}` }
      : {
          cookie: `${SESSION}=${who.token}`,
          host: HOST,
          origin: `http://${HOST}`,
          [CSRF_HEADER]: who.csrf,
        };
  const options: Record<string, unknown> = { method, url, headers };
  if (payload !== undefined) options.payload = payload;
  // Arbitrary JSON bodies: the inject typing wants a narrower payload type than tests need.
  return h.app.inject(options as unknown as InjectOptions);
}

const OPERATOR: Caller = { bearer: TEST_OPERATOR_TOKEN };

function endWith(reply: string): Parameters<Harness["provider"]["onRun"]>[0] {
  return async (req, gw) => {
    const ended: RunEnded = {
      type: "run_ended",
      runId: req.runId as RunId,
      outcome: "completed",
      summary: {
        done: "done",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply,
      },
      usage: [],
    };
    await gw.post("ended", ended);
  };
}

async function settled(runId: string): Promise<RunRecord> {
  const runs = h.app.deskmates.ctx.runs;
  await waitFor(
    () => ["succeeded", "silent", "failed"].includes(runs.mustGet(runId as RunId).status),
    3000,
    "run end",
  );
  return runs.mustGet(runId as RunId);
}

function count(table: string): number {
  return (
    h.app.deskmates.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

function counts() {
  return {
    threads: count("threads"),
    members: count("thread_members"),
    tasks: count("tasks"),
    messages: count("thread_messages"),
    runs: count("runs"),
  };
}

const SCHEMA = { type: "object", required: ["rows"], properties: { rows: { type: "number" } } };

function submitBody(botId: string, extra: Record<string, unknown> = {}) {
  return {
    externalKey: "job-42",
    botId,
    title: "Count the rows",
    instruction: "Count the rows in the orders table and deliver the number.",
    description: "Nightly reconciliation",
    outputSchema: SCHEMA,
    deadline: "2999-01-01T00:00:00+02:00",
    ...extra,
  };
}

describe("a new submission", () => {
  it("creates one thread, one task, one must-reply message and the run it wakes", async () => {
    const { workspace, bot } = await h.seed();
    h.app.deskmates.scheduler.stop();
    const before = counts();
    const res = await call(
      OPERATOR,
      "POST",
      `/api/workspaces/${workspace.id}/submit`,
      submitBody(bot.id, {
        attachments: [{ name: "spec.md", mimeType: "text/markdown", ref: "/work/spec.md" }],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as SubmitResponse;
    expect(Object.keys(body).sort()).toEqual(["messageId", "runs", "taskId", "threadId"]);
    expect(counts()).toEqual({
      threads: before.threads + 1,
      members: before.members + 1,
      tasks: before.tasks + 1,
      messages: before.messages + 1,
      runs: before.runs + 1,
    });
    const { ctx } = h.app.deskmates;
    const thread = ctx.threads.mustGet(body.threadId);
    expect(thread).toMatchObject({
      workspaceId: workspace.id,
      kind: "chat",
      channel: agentChannel({ kind: "operator" }),
      externalKey: "job-42",
      title: "Count the rows",
      deadline: "2998-12-31T22:00:00.000Z",
    });
    expect(ctx.threads.members(thread.id).map((m) => m.botId)).toEqual([bot.id]);
    const task = ctx.tasks.mustGet(workspace.id as WorkspaceId, body.taskId);
    expect(task).toMatchObject({
      title: "Count the rows",
      description: "Nightly reconciliation",
      ownerBotId: bot.id,
      status: "planned",
      threadIds: [thread.id],
      outputSchema: SCHEMA,
    });
    const message = ctx.messages.mustGet(body.messageId);
    expect(message).toMatchObject({
      threadId: thread.id,
      seq: 1,
      authorKind: "human",
      // The operator credential with no authorId is `web`, as on the message route.
      authorId: "web",
      body: "Count the rows in the orders table and deliver the number.",
      mustReply: true,
      attachments: [{ name: "spec.md", mimeType: "text/markdown", ref: "/work/spec.md" }],
    });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: message.id,
      status: "queued",
    });
  });

  it("offers task_deliver with the new task to the run it wakes", async () => {
    const { workspace, bot } = await h.seed();
    h.provider.onRun(endWith("on it"));
    const res = await call(
      OPERATOR,
      "POST",
      `/api/workspaces/${workspace.id}/submit`,
      submitBody(bot.id),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as SubmitResponse;
    const run = await settled(body.runs[0]?.id as string);
    expect(run.status).toBe("succeeded");
    const request = h.provider.execCalls.find((c) => c.request.runId === run.id)?.request;
    expect(request?.tools).toContain("task_deliver");
    expect(request?.deliverableTasks).toEqual([
      { id: body.taskId, title: "Count the rows", outputSchema: SCHEMA, scopeVersion: 1 },
    ]);
  });

  it("records a silent end of the woken run as failed with reason no_reply", async () => {
    const { workspace, bot } = await h.seed();
    h.provider.onRun(endWith(""));
    const res = await call(
      OPERATOR,
      "POST",
      `/api/workspaces/${workspace.id}/submit`,
      submitBody(bot.id),
    );
    const run = await settled((res.json() as SubmitResponse).runs[0]?.id as string);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(RUN_ERROR_NO_REPLY);
  });
});

describe("a repeated externalKey", () => {
  it("returns 200 with the existing ids and writes nothing", async () => {
    const { workspace, bot } = await h.seed();
    h.provider.onRun(endWith("done"));
    const url = `/api/workspaces/${workspace.id}/submit`;
    const first = await call(OPERATOR, "POST", url, submitBody(bot.id));
    expect(first.statusCode).toBe(201);
    const created = first.json() as SubmitResponse;
    await settled(created.runs[0]?.id as string);
    const before = snapshotDatabase(h.app.deskmates.ctx);
    // A retry is recognised by its key alone, even when the rest of the body differs.
    const again = await call(
      OPERATOR,
      "POST",
      url,
      submitBody(bot.id, { title: "Something else", instruction: "again" }),
    );
    expect(again.statusCode, again.body).toBe(200);
    const repeated = again.json() as SubmitResponse;
    expect(repeated).toMatchObject({
      threadId: created.threadId,
      taskId: created.taskId,
      messageId: created.messageId,
    });
    expect(repeated.runs.map((r) => [r.id, r.status])).toEqual([
      [created.runs[0]?.id, "succeeded"],
    ]);
    expect(snapshotDatabase(h.app.deskmates.ctx)).toBe(before);
  });

  it("is per caller: another principal's same key is a new submission", async () => {
    const { workspace, bot } = await h.seed();
    h.app.deskmates.scheduler.stop();
    const url = `/api/workspaces/${workspace.id}/submit`;
    const first = await call(OPERATOR, "POST", url, submitBody(bot.id));
    const { token } = h.app.deskmates.ctx.auth.servicePrincipals.create(
      DEFAULT_TENANT_ID,
      { name: "other-agent" },
      "human:test",
      "admin",
    );
    const second = await call({ bearer: token }, "POST", url, submitBody(bot.id));
    expect(second.statusCode, second.body).toBe(201);
    expect((second.json() as SubmitResponse).threadId).not.toBe(
      (first.json() as SubmitResponse).threadId,
    );
  });

  it("is found again by GET submissions, with the task and the latest run", async () => {
    const { workspace, bot } = await h.seed();
    h.app.deskmates.scheduler.stop();
    const created = (
      await call(OPERATOR, "POST", `/api/workspaces/${workspace.id}/submit`, submitBody(bot.id))
    ).json() as SubmitResponse;
    const found = await call(
      OPERATOR,
      "GET",
      `/api/workspaces/${workspace.id}/submissions?externalKey=job-42`,
    );
    expect(found.statusCode, found.body).toBe(200);
    const view = found.json() as SubmissionResponse;
    expect(view.thread.id).toBe(created.threadId);
    expect(view.task?.id).toBe(created.taskId);
    expect(view.latestRun?.id).toBe(created.runs[0]?.id);
    const missing = await call(
      OPERATOR,
      "GET",
      `/api/workspaces/${workspace.id}/submissions?externalKey=job-43`,
    );
    expect(missing.statusCode).toBe(404);
    const noKey = await call(OPERATOR, "GET", `/api/workspaces/${workspace.id}/submissions`);
    expect(noKey.statusCode).toBe(400);
  });
});

describe("a refused submission", () => {
  it("is a 400 that writes nothing", async () => {
    const { workspace, bot } = await h.seed();
    h.app.deskmates.scheduler.stop();
    const { ctx } = h.app.deskmates;
    const elsewhere = ctx.workspaces.create({ name: "ws-2", sandboxProvider: "docker" });
    const stranger = ctx.bots.create({
      name: "stranger",
      role: "test",
      workspaceId: elsewhere.id as WorkspaceId,
    });
    const before = snapshotDatabase(ctx);
    const without = (key: string) => {
      const body: Record<string, unknown> = submitBody(bot.id);
      delete body[key];
      return body;
    };
    const cases: Array<[string, unknown]> = [
      ["bot of another workspace", submitBody(stranger.id)],
      ["unparseable deadline", submitBody(bot.id, { deadline: "tomorrow" })],
      ["deadline without a zone", submitBody(bot.id, { deadline: "2999-01-01T00:00:00" })],
      ["deadline already past", submitBody(bot.id, { deadline: "2001-01-01T00:00:00Z" })],
      ["schema not an object", submitBody(bot.id, { outputSchema: "rows" })],
      ["schema with a bad type", submitBody(bot.id, { outputSchema: { type: "nope" } })],
      ["missing externalKey", without("externalKey")],
      ["missing botId", without("botId")],
      ["missing title", without("title")],
      ["missing instruction", without("instruction")],
      ["blank instruction", submitBody(bot.id, { instruction: "  " })],
      ["control bytes in the key", submitBody(bot.id, { externalKey: "a\u0000b" })],
      ["unknown property", submitBody(bot.id, { priority: "high" })],
      ["malformed attachment", submitBody(bot.id, { attachments: [{ name: "x" }] })],
      ["not an object", ["externalKey"]],
    ];
    for (const [label, payload] of cases) {
      const res = await call(OPERATOR, "POST", `/api/workspaces/${workspace.id}/submit`, payload);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expect(snapshotDatabase(ctx), label).toBe(before);
    }
  });
});

describe("service principals and tenants", () => {
  it("binds a service principal's submission to agent:<id> and attributes its message", async () => {
    const { workspace, bot } = await h.seed();
    h.app.deskmates.scheduler.stop();
    const { record, token } = h.app.deskmates.ctx.auth.servicePrincipals.create(
      DEFAULT_TENANT_ID,
      { name: "ci-agent" },
      "human:test",
      "admin",
    );
    const res = await call(
      { bearer: token },
      "POST",
      `/api/workspaces/${workspace.id}/submit`,
      submitBody(bot.id, { authorId: "someone-else" }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as SubmitResponse;
    const { ctx } = h.app.deskmates;
    expect(ctx.threads.mustGet(body.threadId).channel).toBe(`agent:${record.id}`);
    expect(ctx.messages.mustGet(body.messageId).authorId).toBe(`service:${record.id}`);
    // The principal finds its own key; the operator's channel does not hold it.
    expect(
      (
        await call(
          { bearer: token },
          "GET",
          `/api/workspaces/${workspace.id}/submissions?externalKey=job-42`,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          OPERATOR,
          "GET",
          `/api/workspaces/${workspace.id}/submissions?externalKey=job-42`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it("binds a signed-in person's submission to agent:user:<id>", async () => {
    h.app.deskmates.scheduler.stop();
    const A = await seedTenant(h.app.deskmates.ctx, "A");
    const res = await call(
      A,
      "POST",
      `/api/workspaces/${A.ids.workspace}/submit`,
      submitBody(A.ids.bot, { authorId: "forged" }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as SubmitResponse;
    const { ctx } = h.app.deskmates;
    expect(ctx.threads.mustGet(body.threadId).channel).toBe(`agent:user:${A.ownerUserId}`);
    expect(ctx.messages.mustGet(body.messageId).authorId).toBe(`user:${A.ownerUserId}`);
  });

  it("does not limit how many of the principal's runs are in flight (ADR-0022 amendment 5)", async () => {
    const { workspace, bot } = await h.seed();
    h.app.deskmates.scheduler.stop();
    const { ctx } = h.app.deskmates;
    const { token } = ctx.auth.servicePrincipals.create(
      DEFAULT_TENANT_ID,
      { name: "busy" },
      "human:test",
      "admin",
    );
    const url = `/api/workspaces/${workspace.id}/submit`;
    for (const externalKey of ["job-42", "job-43", "job-44"]) {
      const res = await call({ bearer: token }, "POST", url, submitBody(bot.id, { externalKey }));
      expect(res.statusCode, res.body).toBe(201);
    }
    // A retry of a submission it already made is answered, not repeated: it creates nothing.
    const before = snapshotDatabase(ctx);
    const retry = await call(
      { bearer: token },
      "POST",
      url,
      submitBody(bot.id, { externalKey: "job-43" }),
    );
    expect(retry.statusCode).toBe(200);
    expect(snapshotDatabase(ctx)).toBe(before);
  });

  it("answers another tenant's workspace or bot with the uniform 404 and writes nothing", async () => {
    h.app.deskmates.scheduler.stop();
    const { ctx } = h.app.deskmates;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const { token } = ctx.auth.servicePrincipals.create(
      B.tenantId,
      { name: "b-agent" },
      "human:test",
      "admin",
    );
    const asB: Caller = { bearer: token };
    const before = snapshotDatabase(ctx);
    const foreignWorkspace = await call(
      asB,
      "POST",
      `/api/workspaces/${A.ids.workspace}/submit`,
      submitBody(A.ids.bot),
    );
    expect(foreignWorkspace.statusCode).toBe(404);
    expect(foreignWorkspace.json()).toEqual(DENIAL);
    const foreignBot = await call(
      asB,
      "POST",
      `/api/workspaces/${B.ids.workspace}/submit`,
      submitBody(A.ids.bot as BotId),
    );
    expect(foreignBot.statusCode).toBe(404);
    expect(foreignBot.json()).toEqual(DENIAL);
    const lookup = await call(
      asB,
      "GET",
      `/api/workspaces/${A.ids.workspace}/submissions?externalKey=job-42`,
    );
    expect(lookup.statusCode).toBe(404);
    expect(lookup.json()).toEqual(DENIAL);
    expect(snapshotDatabase(ctx)).toBe(before);
    // Its own workspace and bot are accepted.
    const own = await call(
      asB,
      "POST",
      `/api/workspaces/${B.ids.workspace}/submit`,
      submitBody(B.ids.bot),
    );
    expect(own.statusCode, own.body).toBe(201);
  });
});
