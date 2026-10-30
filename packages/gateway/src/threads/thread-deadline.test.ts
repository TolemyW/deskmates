// T1: a thread's deadline (issue #21, decision 4). The scheduler's periodic tick cancels every
// non-terminal run of a thread whose deadline has passed (`cancelled`, reason `deadline`), frees
// the lane, publishes `run_status` and never starts a queued run of that thread. A thread past its
// deadline still takes messages, but they start no run, and the post response says so.

import {
  CSRF_HEADER,
  RUN_ERROR_DEADLINE,
  type RunId,
  type Thread,
  type ThreadId,
  type ThreadMessage,
} from "@deskmates/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../events/bus.js";
import { buildGateway } from "../index.js";
import type { RunRecord } from "../ledger/runs.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { type Harness, startHarness, testConfig, waitFor } from "../test-support/harness.js";
import { type TenantFixture, seedTenant } from "../test-support/tenants.js";

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("thread deadline", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("is set on create, normalized, shown in the thread detail, and patched or cleared", async () => {
    const { workspace, bot } = await h.seed();
    const teammate = h.app.deskmates.ctx.bots.create({
      name: "deadline-peer",
      role: "tester",
      workspaceId: workspace.id,
    });
    const created = await h.api<{ thread: Thread }>("POST", "/api/threads", {
      workspaceId: workspace.id,
      botIds: [bot.id, teammate.id],
      deadline: "2999-01-01T09:30:00+08:00",
    });
    expect(created.status).toBe(201);
    expect(created.json.thread.deadline).toBe("2999-01-01T01:30:00.000Z");
    const id = created.json.thread.id;
    const detail = await h.api<{ thread: Thread }>("GET", `/api/threads/${id}`);
    expect(detail.json.thread.deadline).toBe("2999-01-01T01:30:00.000Z");

    const patched = await h.api<{ thread: Thread }>("PATCH", `/api/threads/${id}`, {
      deadline: FUTURE,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.thread.deadline).toBe(FUTURE);
    const cleared = await h.api<{ thread: Thread }>("PATCH", `/api/threads/${id}`, {
      deadline: null,
    });
    expect(cleared.json.thread.deadline).toBeUndefined();
  });

  it("refuses a deadline that is not an ISO timestamp", async () => {
    const { workspace, bot, thread } = await h.seed();
    for (const deadline of ["tomorrow", "2026-10-09", 42]) {
      const create = await h.api("POST", "/api/threads", {
        workspaceId: workspace.id,
        botIds: [bot.id],
        deadline,
      });
      expect(create.status, String(deadline)).toBe(400);
      const patch = await h.api("PATCH", `/api/threads/${thread.id}`, { deadline });
      expect(patch.status, String(deadline)).toBe(400);
    }
    const missing = await h.api("PATCH", `/api/threads/${thread.id}`, {});
    expect(missing.status).toBe(400);
  });

  it("cancels a running run on the tick once the deadline passes, frees the lane and publishes", async () => {
    const { thread } = await h.seed();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lateEnd: number | undefined;
    h.provider.onRun(async (req, gw) => {
      await held;
      const res = await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "late",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "too late",
        },
        usage: [],
      });
      lateEnd = res.status;
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "start" },
    );
    const runId = posted.json.runs[0]?.id as RunId;
    const { ctx, scheduler } = h.app.deskmates;
    await waitFor(() => ctx.runs.mustGet(runId).status === "running", 3000, "running");

    const published: GatewayEvent[] = [];
    const unsubscribe = ctx.bus.subscribe((event) => published.push(event));
    await h.api("PATCH", `/api/threads/${thread.id}`, { deadline: PAST });
    scheduler.tick();
    unsubscribe();

    const run = ctx.runs.mustGet(runId);
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe(RUN_ERROR_DEADLINE);
    expect(ctx.runs.laneBusy(run.botId, run.lane)).toBe(false);
    expect(
      published.some(
        (e) => e.type === "run_status" && e.run.id === runId && e.run.status === "cancelled",
      ),
    ).toBe(true);

    release();
    await waitFor(() => lateEnd !== undefined, 3000, "late end");
    expect(lateEnd).toBeGreaterThanOrEqual(400);
    expect(ctx.runs.mustGet(runId).status).toBe("cancelled");
    expect(ctx.messages.list(thread.id).some((m) => m.body === "too late")).toBe(false);
  });

  it("cancels a parked run of the thread too", async () => {
    const { thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    const created = ctx.runs.create({
      botId: (await firstMember(thread.id)) as RunRecord["botId"],
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "msg_none",
      config: ctx.runConfig(),
    });
    ctx.runs.transition(created.id, "running");
    ctx.runs.transition(created.id, "waiting_approval", {
      resumePayload: { sdkSessionId: "sess_1", approvalId: "apr_none" },
    });
    ctx.threads.setDeadline(thread.id, PAST);
    scheduler.tick();
    const run = ctx.runs.mustGet(created.id);
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe(RUN_ERROR_DEADLINE);
  });

  it("closes the approval of a run waiting on it and kills a sidecar that does not exit", async () => {
    const { thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    scheduler.cancelGraceMs = 20;
    let requested = false;
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", {
        type: "approval_request",
        approvalId: "apr-deadline",
        action: { toolName: "Bash", input: { command: "git push" }, argumentSummary: "git push" },
        riskLevel: "L2",
        toolUseId: "toolu_deadline",
      });
      requested = true;
      // Never exits by itself: only the kill ends this process.
      await new Promise(() => {});
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "push it" },
    );
    const runId = posted.json.runs[0]?.id as RunId;
    await waitFor(() => requested, 3000, "approval requested");
    ctx.threads.setDeadline(thread.id, PAST);
    scheduler.tick();
    expect(ctx.runs.mustGet(runId).status).toBe("cancelled");
    const approval = ctx.approvals.mustGet("apr-deadline" as never);
    expect(approval.decision).toBe("deny");
    expect(approval.decidedBy).toBe("system:deadline");
    await waitFor(() => h.provider.execCalls[0]?.req.signal?.aborted === true, 3000, "killed");
    await scheduler.drain();
  });

  it("refuses to start a queued run of a thread past its deadline", async () => {
    const { thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    ctx.threads.setDeadline(thread.id, PAST);
    const queued = ctx.runs.create({
      botId: (await firstMember(thread.id)) as RunRecord["botId"],
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "msg_none",
      config: ctx.runConfig(),
    });
    scheduler.tick();
    await scheduler.drain();
    expect(h.provider.execCalls).toHaveLength(0);
    const run = ctx.runs.mustGet(queued.id);
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe(RUN_ERROR_DEADLINE);
  });

  it("leaves runs of a thread whose deadline is still ahead alone", async () => {
    const { workspace, bot } = await h.seed();
    const created = await h.api<{ thread: Thread }>("POST", "/api/threads", {
      workspaceId: workspace.id,
      botIds: [bot.id],
      deadline: FUTURE,
    });
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "ok",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "ok",
        },
        usage: [],
      });
    });
    const posted = await h.api<{ runs: RunRecord[]; deadlinePassed?: boolean }>(
      "POST",
      `/api/threads/${created.json.thread.id}/messages`,
      { body: "in time" },
    );
    expect(posted.json.deadlinePassed).toBeUndefined();
    const runId = posted.json.runs[0]?.id as RunId;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(runId).status === "succeeded",
      3000,
      "succeeded",
    );
  });

  it("stores a message posted past the deadline, starts no run, and says so", async () => {
    const { thread } = await h.seed();
    await h.api("PATCH", `/api/threads/${thread.id}`, { deadline: PAST });
    const posted = await h.api<{
      message: ThreadMessage;
      runs: RunRecord[];
      deadlinePassed?: boolean;
    }>("POST", `/api/threads/${thread.id}/messages`, { body: "anyone there?" });
    expect(posted.status).toBe(201);
    expect(posted.json.runs).toEqual([]);
    expect(posted.json.deadlinePassed).toBe(true);
    expect(h.app.deskmates.ctx.messages.list(thread.id).map((m) => m.body)).toEqual([
      "anyone there?",
    ]);
    expect(h.app.deskmates.ctx.runs.list({ threadId: thread.id })).toEqual([]);
  });

  async function firstMember(threadId: ThreadId): Promise<string | undefined> {
    return h.app.deskmates.ctx.threads.members(threadId)[0]?.botId;
  }
});

describe("another tenant's thread", () => {
  const SESSION = "__Host-deskmates-session";
  const HOST = "gw.test";
  let app: FastifyInstance;
  let A: TenantFixture;
  let B: TenantFixture;

  beforeAll(async () => {
    app = buildGateway(
      testConfig({
        secretsKey: Buffer.alloc(32, 7).toString("base64"),
        auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
      }),
      new FakeProvider(),
      { surface: "combined-test", startCron: false },
    );
    await app.ready();
    app.deskmates.scheduler.stop();
    A = await seedTenant(app.deskmates.ctx, "A");
    B = await seedTenant(app.deskmates.ctx, "B");
  });
  afterAll(async () => {
    await app.close();
  });

  function as(who: TenantFixture, method: string, url: string, payload: unknown) {
    // Arbitrary JSON bodies: the inject typing wants a narrower payload type than tests need.
    return app.inject({
      method,
      url,
      payload,
      headers: {
        cookie: `${SESSION}=${who.token}`,
        host: HOST,
        origin: `http://${HOST}`,
        [CSRF_HEADER]: who.csrf,
      },
    } as unknown as InjectOptions);
  }

  it("answers a deadline patch with 404 and changes nothing", async () => {
    const threadId = A.ids.thread as ThreadId;
    const res = await as(B, "PATCH", `/api/threads/${threadId}`, { deadline: PAST });
    expect(res.statusCode).toBe(404);
    expect(app.deskmates.ctx.threads.mustGet(threadId).deadline).toBeUndefined();
    const own = await as(A, "PATCH", `/api/threads/${threadId}`, { deadline: FUTURE });
    expect(own.statusCode).toBe(200);
  });

  it("answers a must-reply post with 404 and stores nothing", async () => {
    const threadId = A.ids.thread as ThreadId;
    const before = app.deskmates.ctx.messages.list(threadId).length;
    const res = await as(B, "POST", `/api/threads/${threadId}/messages`, {
      body: "do this",
      mustReply: true,
    });
    expect(res.statusCode).toBe(404);
    expect(app.deskmates.ctx.messages.list(threadId)).toHaveLength(before);
  });
});
