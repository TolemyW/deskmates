// T1: `PATCH /api/threads/:id` pauses and resumes a thread (ADR-0005 amendment 3, decision 23;
// resume per rewritten decision 22). Independent of the deadline field, audited with who acted,
// refused with a run token; a `thread_post` into the paused thread is told why (decision 27).

import { RUN_ERROR_OPERATOR_PAUSE, type Thread } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const app = buildGateway(testConfig(), new FakeProvider(), {
    startCron: false,
    surface: "combined-test",
  });
  apps.push(app);
  await app.ready();
  app.deskmates.scheduler.stop();
  const { ctx } = app.deskmates;
  const ws = ctx.workspaces.create({ name: "qa", sandboxProvider: "docker" });
  const alice = ctx.bots.create({ name: "alice", role: "a", workspaceId: ws.id });
  const bob = ctx.bots.create({ name: "bob", role: "b", workspaceId: ws.id });
  const thread = ctx.threads.create({ workspaceId: ws.id, botIds: [alice.id, bob.id] });
  const patch = (payload: Record<string, unknown>, credential = TEST_OPERATOR_TOKEN) =>
    app.inject({
      method: "PATCH",
      url: `/api/threads/${thread.id}`,
      headers: { authorization: `Bearer ${credential}` },
      payload,
    });
  const audits = () =>
    ctx.db
      .prepare(
        "SELECT action, actor, before_json, after_json FROM audit_events WHERE target_id = ? ORDER BY seq",
      )
      .all(thread.id) as {
      action: string;
      actor: string;
      before_json: string;
      after_json: string;
    }[];
  return { app, ctx, alice, bob, thread, patch, audits };
}

describe("operator pause and resume (decision 23)", () => {
  it("pauses without a deadline, records reason operator and cancels queued runs", async () => {
    const { ctx, thread, patch, audits } = await setup();
    const queued = ctx.router.postHuman({ threadId: thread.id, body: "@bob please" }).runs[0];
    const res = await patch({ status: "paused" });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread).toMatchObject({ status: "paused", pauseReason: "operator" });
    expect(res.json().thread).not.toHaveProperty("resumeAt");
    expect(res.json().thread).not.toHaveProperty("deadline");
    expect(ctx.runs.mustGet(queued?.id as NonNullable<typeof queued>["id"])).toMatchObject({
      status: "cancelled",
      error: RUN_ERROR_OPERATOR_PAUSE,
    });
    const rows = audits();
    expect(rows.map((row) => row.action)).toEqual(["thread.pause"]);
    expect(JSON.parse(rows[0]?.before_json ?? "")).toEqual({ status: "active" });
    expect(JSON.parse(rows[0]?.after_json ?? "")).toMatchObject({
      status: "paused",
      pauseReason: "operator",
      cancelledRunIds: [queued?.id],
    });
    // Asking for the same state again changes nothing and audits nothing.
    await patch({ status: "paused" });
    expect(audits()).toHaveLength(1);
  });

  it("resumes with one notice and a budget reset, and audits it", async () => {
    const { ctx, thread, patch, audits } = await setup();
    await patch({ status: "paused" });
    const res = await patch({ status: "active" });
    expect(res.statusCode).toBe(200);
    const resumed = res.json().thread as Thread;
    expect(resumed.status).toBe("active");
    const notice = ctx.messages.list(thread.id).at(-1);
    expect(notice).toMatchObject({ authorKind: "system" });
    expect(notice?.body).toMatch(/^Resumed by .+; turn budget reset\.$/);
    expect(resumed.budgetResetSeq).toBe(notice?.seq);
    expect(audits().map((row) => row.action)).toEqual(["thread.pause", "thread.resume"]);
  });

  it("validates the status and still changes the deadline alone", async () => {
    const { patch } = await setup();
    expect((await patch({ status: "stopped" })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    const res = await patch({ deadline: "2099-01-01T00:00:00Z" });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread).toMatchObject({ status: "active" });
  });

  it("is refused with a run token", async () => {
    const { ctx, alice, thread, patch } = await setup();
    const run = ctx.runs.create({
      botId: alice.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
    });
    const res = await patch({ status: "paused" }, ctx.tokens.issue(run.id).token);
    expect(res.statusCode).toBe(401);
    expect(ctx.threads.mustGet(thread.id).status).toBe("active");
  });
});

describe("a post into a paused thread is told (decision 27)", () => {
  it("answers thread_post with the operator pause and that nobody was woken", async () => {
    const { app, ctx, alice, bob, thread, patch } = await setup();
    await patch({ status: "paused" });
    const run = ctx.runs.create({
      botId: alice.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
    });
    const res = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/messages`,
      headers: { authorization: `Bearer ${ctx.tokens.issue(run.id).token}` },
      payload: { tool: "thread_post", body: "status update", attachments: [] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().routing.paused).toEqual({ reason: "operator" });
    expect(ctx.runs.list({ botId: bob.id })).toHaveLength(0);
  });
});
