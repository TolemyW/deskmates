import { THREAD_LINK_ATTACHMENT_MIME, type ThreadMessage } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../events/bus.js";
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
  const alice = ctx.bots.create({
    name: "alice",
    role: "chief",
    workspaceId: ws.id,
    messageAllowlist: ["bob"],
  });
  const bob = ctx.bots.create({ name: "bob", role: "expert", workspaceId: ws.id });
  const chat = ctx.threads.create({ workspaceId: ws.id, botIds: [alice.id] });
  const run = ctx.runs.create({
    botId: alice.id,
    threadId: chat.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
  });
  const token = ctx.tokens.issue(run.id).token;
  const post = (payload: Record<string, unknown>, credential = token) =>
    app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/messages`,
      headers: { authorization: `Bearer ${credential}` },
      payload,
    });
  return { app, ctx, run, bob, chat, post };
}

describe("direct-message internal route", () => {
  it("thread_post says the mention woke nobody, and the published message carries no routing facts", async () => {
    const { app, ctx, run, bob } = await setup();
    const thread = ctx.threads.create({
      workspaceId: ctx.bots.mustGet(run.botId).workspaceId,
      botIds: [run.botId, bob.id],
    });
    const stalled = ctx.runs.create({
      botId: run.botId,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
    });
    ctx.threads.setStatus(thread.id, "paused");
    const events: GatewayEvent[] = [];
    const unsubscribe = ctx.bus.subscribe((event) => events.push(event));
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${stalled.id}/messages`,
      headers: { authorization: `Bearer ${ctx.tokens.issue(stalled.id).token}` },
      payload: { tool: "thread_post", body: "@bob where are we?", attachments: [] },
    });
    unsubscribe();
    expect(response.statusCode).toBe(201);
    expect(response.json().routing).toMatchObject({
      addressed: ["bob"],
      wakeBlocked: "thread_paused",
    });
    for (const key of ["runs", "changed", "blocked", "wakeBlocked"])
      expect(response.json().message).not.toHaveProperty(key);
    expect(ctx.runs.list({ botId: bob.id })).toHaveLength(0);
    const published = events.filter((event) => event.type === "thread_message");
    expect(published).toHaveLength(1);
    for (const event of published)
      for (const key of ["runs", "changed", "blocked", "wakeBlocked"])
        expect(event.type === "thread_message" && event.message).not.toHaveProperty(key);
  });

  it("thread_post reports no refused wake for an unaddressed message", async () => {
    const { app, ctx, run, bob } = await setup();
    const thread = ctx.threads.create({
      workspaceId: ctx.bots.mustGet(run.botId).workspaceId,
      botIds: [run.botId, bob.id],
    });
    const stalled = ctx.runs.create({
      botId: run.botId,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
    });
    ctx.threads.setStatus(thread.id, "paused");
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${stalled.id}/messages`,
      headers: { authorization: `Bearer ${ctx.tokens.issue(stalled.id).token}` },
      payload: { tool: "thread_post", body: "progress note", attachments: [] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().routing).not.toHaveProperty("wakeBlocked");
  });

  it("keeps private inbox lookup and activity routes inside the authenticated tenant", async () => {
    const { app, ctx } = await setup();
    const tenant = ctx.auth.users.createTenant({ name: "other tenant" });
    const ws = ctx.workspaces.create({
      name: "other",
      sandboxProvider: "docker",
      tenantId: tenant.id,
    });
    const bot = ctx.bots.create({ name: "hidden", role: "other", workspaceId: ws.id });
    const inbox = ctx.privateChats.resolve(bot.id);
    const headers = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
    for (const request of [
      { method: "POST" as const, url: `/api/bots/${bot.id}/private-chat`, payload: {} },
      { method: "GET" as const, url: `/api/threads/${inbox.id}/activity` },
      {
        method: "POST" as const,
        url: `/api/threads/${inbox.id}/activity/read`,
        payload: { through: 1 },
      },
    ])
      expect((await app.inject({ ...request, headers })).statusCode).toBe(404);
  });
  it.each(["thread_post", "message_bot"])(
    "deduplicates %s HTTP replays and exposes one operator-only reminder",
    async (tool) => {
      const { app, ctx, bob, post } = await setup();
      const payload = { tool, to: "bob", body: "@bob review the conclusion", requestId: "post-1" };
      const first = await post(payload);
      expect(first.statusCode).toBe(201);
      const second = await post(payload);
      expect(second.json()).toEqual(first.json());
      expect(ctx.runs.list({ botId: bob.id })).toHaveLength(1);
      if (tool === "thread_post")
        expect(first.json().routing).toMatchObject({
          unknown: [],
          handoffs: [{ name: "bob", delivered: true }],
        });
      expect((await post({ ...payload, body: "changed" })).statusCode).toBe(400);
      const headers = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
      const resolved = await app.inject({
        method: "POST",
        url: `/api/bots/${bob.id}/private-chat`,
        headers,
        payload: {},
      });
      expect(resolved.statusCode).toBe(200);
      const thread = resolved.json().thread;
      const url = `/api/threads/${thread.id}/activity`;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url, headers });
      const notices = response.json().handoffs;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ unread: true, status: "queued" });
      expect(ctx.messages.list(thread.id)).toEqual([]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/read`,
            headers,
            payload: { through: notices[0].seq },
          })
        ).statusCode,
      ).toBe(200);
      expect((await app.inject({ method: "GET", url, headers })).json().handoffs[0].unread).toBe(
        false,
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/read`,
            headers,
            payload: { through: -1 },
          })
        ).statusCode,
      ).toBe(400);
    },
  );

  it("routes final replies and returns the recipient outcome to the original private chat", async () => {
    const { app, ctx, bob, run, chat } = await setup();
    const summary = (reply: string) => ({
      done: "handled",
      reply,
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
    });
    const caller = app.deskmates.lifecycle.start(run).run;
    app.deskmates.lifecycle.ended(caller.id, {
      type: "run_ended",
      runId: caller.id,
      outcome: "completed",
      usage: [],
      summary: summary("@bob check the conclusion"),
    });
    const inbox = ctx.privateChats.resolve(bob.id);
    const notice = ctx.privateChats.list(inbox.id, "human:web")[0];
    if (!notice) throw new Error("missing reminder");
    const recipient = app.deskmates.lifecycle.start(ctx.runs.mustGet(notice.runId)).run;
    app.deskmates.lifecycle.ended(recipient.id, {
      type: "run_ended",
      runId: recipient.id,
      outcome: "completed",
      usage: [],
      summary: summary("The conclusion should be updated."),
    });
    expect(ctx.privateChats.list(inbox.id, "human:web")[0]?.status).toBe("succeeded");
    expect(
      ctx.messages
        .list(chat.id)
        .some(
          (m) => m.authorKind === "system" && m.body.includes("The conclusion should be updated."),
        ),
    ).toBe(true);
    expect(ctx.runs.list({ threadId: inbox.id })).toEqual([]);
    expect(ctx.threads.members(chat.id)).toHaveLength(1);
  });

  it("authenticates, records a bus message and emits linked conversation events", async () => {
    const { ctx, run, bob, chat, post } = await setup();
    const events: GatewayEvent[] = [];
    const unsubscribe = ctx.bus.subscribe((event) => events.push(event));
    const result = await post({ tool: "message_bot", to: "bob", body: "Review", attachments: [] });
    expect(result.statusCode).toBe(201);
    const data = result.json<{ message: ThreadMessage; handoff: ThreadMessage }>();
    expect(data.message).toMatchObject({ runId: run.id, body: "Review" });
    expect(data.handoff).toMatchObject({
      threadId: chat.id,
      attachments: [
        {
          name: "Open conversation",
          mimeType: THREAD_LINK_ATTACHMENT_MIME,
          ref: data.message.threadId,
        },
      ],
    });
    expect(ctx.runs.listQueued().find((r) => r.botId === bob.id)).toMatchObject({
      lane: "background",
      threadId: data.message.threadId,
      triggerRef: data.message.id,
    });
    expect(events.filter((e) => e.type === "thread_message").map((e) => e.threadId)).toEqual([
      data.message.threadId,
      chat.id,
    ]);
    expect(events.some((e) => e.type === "run_status" && e.run.botId === bob.id)).toBe(true);
    unsubscribe();
  });

  it("refuses an invalid token and invalid tool payloads before changing any thread", async () => {
    const { ctx, post } = await setup();
    expect(
      (await post({ tool: "message_bot", to: "bob", body: "Review" }, "invalid")).statusCode,
    ).toBe(401);
    for (const payload of [
      { tool: "message_bot", body: "Review" },
      { tool: "message_bot", to: 42, body: "Review" },
      { tool: "message_bot", to: "bob", body: "" },
      { tool: "message_bot", to: "bob", body: "Review", attachments: [42] },
      { tool: "message_bot", to: "missing", body: "Review" },
      { tool: "unknown", to: "bob", body: "Review" },
    ]) {
      expect((await post(payload)).statusCode).toBe(400);
    }
    expect(ctx.threads.list()).toHaveLength(1);
  });
});
