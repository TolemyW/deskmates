import type { BotId, ThreadId } from "@deskmates/contracts";
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
  const workspace = ctx.workspaces.create({ name: "members", sandboxProvider: "docker" });
  const bots = ["alice", "bob", "carol", "dan", "erin", "frank", "grace"].map((name) =>
    ctx.bots.create({ name, role: "member", workspaceId: workspace.id }),
  );
  const otherWorkspace = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
  const outsider = ctx.bots.create({
    name: "outsider",
    role: "member",
    workspaceId: otherWorkspace.id,
  });
  const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [botAt(bots, 0).id] });
  const auth = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
  const add = (
    botIds: string[],
    id: ThreadId = thread.id,
    headers: Record<string, string> = auth,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/threads/${id}/members`,
      headers,
      payload: { botIds },
    });
  const remove = (botId: BotId, id: ThreadId = thread.id, headers: Record<string, string> = auth) =>
    app.inject({
      method: "DELETE",
      url: `/api/threads/${id}/members/${botId}`,
      headers,
    });
  return { app, ctx, bots, outsider, thread, add, remove };
}

function botAt<T>(items: T[], index: number): T {
  const item = items[index];
  if (!item) throw new Error(`missing bot ${index}`);
  return item;
}

describe("explicit chat membership", () => {
  it("adds a batch atomically, enforces workspace and six-member limits, and emits only real changes", async () => {
    const { ctx, bots, outsider, thread, add, remove } = await setup();
    const events: string[] = [];
    ctx.bus.subscribe((event) => events.push(event.type));
    expect((await add([botAt(bots, 1).id, outsider.id])).statusCode).toBe(400);
    expect(ctx.threads.members(thread.id)).toHaveLength(1);
    expect((await add([botAt(bots, 1).id, "missing"])).statusCode).toBe(404);
    expect(ctx.threads.members(thread.id)).toHaveLength(1);
    const added = await add(bots.slice(1, 6).map((bot) => bot.id));
    expect(added.statusCode).toBe(200);
    expect(added.json().members).toHaveLength(6);
    expect(ctx.runs.list({ threadId: thread.id })).toEqual([]);
    expect((await add([botAt(bots, 6).id])).statusCode).toBe(400);
    expect(ctx.threads.members(thread.id)).toHaveLength(6);
    expect((await add([botAt(bots, 1).id, botAt(bots, 1).id])).statusCode).toBe(200);
    expect(events).toEqual(["thread_members"]);
    expect((await remove(botAt(bots, 6).id)).statusCode).toBe(200);
    expect(events).toEqual(["thread_members"]);
  });

  it("confines changes to the operator surface and chat threads", async () => {
    const { ctx, bots, thread, add, remove } = await setup();
    expect((await add([botAt(bots, 1).id], thread.id, {})).statusCode).toBe(401);
    expect((await remove(botAt(bots, 0).id, thread.id, {})).statusCode).toBe(401);
    const run = ctx.runs.create({
      botId: botAt(bots, 0).id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
    });
    const token = ctx.tokens.issue(run.id).token;
    expect(
      (await add([botAt(bots, 1).id], thread.id, { authorization: `Bearer ${token}` })).statusCode,
    ).toBe(401);
    const bus = ctx.threads.create({
      workspaceId: thread.workspaceId,
      kind: "bus",
      botIds: [botAt(bots, 0).id, botAt(bots, 1).id],
    });
    expect((await add([botAt(bots, 2).id], bus.id)).statusCode).toBe(400);
    expect((await remove(botAt(bots, 1).id, bus.id)).statusCode).toBe(400);
  });

  it("keeps human mention invitations and announces their membership change", async () => {
    const { app, ctx, bots, thread } = await setup();
    const events: string[] = [];
    ctx.bus.subscribe((event) => events.push(event.type));
    const response = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
      payload: { body: "@bob please help" },
    });
    expect(response.statusCode).toBe(201);
    expect(ctx.threads.member(thread.id, botAt(bots, 1).id)?.lastSeenSeq).toBe(0);
    expect(response.json().runs).toHaveLength(1);
    expect(events).toContain("thread_members");
  });

  it("rejects busy and pending-walk removals, then preserves history and resets delivery on rejoin", async () => {
    const { ctx, bots, thread, add, remove } = await setup();
    const alice = botAt(bots, 0);
    const bob = botAt(bots, 1);
    expect((await remove(alice.id)).statusCode).toBe(400);
    await add([bob.id]);
    const human = ctx.router.postHuman({ threadId: thread.id, body: "hello group" });
    expect(human.runs).toHaveLength(1);
    // Bob is a future target in this durable walk even though no Bob run exists yet.
    expect((await remove(bob.id)).statusCode).toBe(409);
    expect(ctx.threads.member(thread.id, bob.id)).toBeDefined();
    // A parked run cannot be orphaned by removal either.
    ctx.db
      .prepare(
        "UPDATE thread_routing_walks SET status = 'complete', active_run_id = NULL WHERE thread_id = ?",
      )
      .run(thread.id);
    const parked = ctx.runs.create({
      botId: bob.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: human.message.id,
    });
    ctx.db.prepare("UPDATE runs SET status = 'waiting_approval' WHERE id = ?").run(parked.id);
    expect((await remove(bob.id)).statusCode).toBe(409);
    ctx.runs.transition(parked.id, "cancelled");
    ctx.threads.advanceLastSeen(thread.id, bob.id, human.message.seq);
    ctx.sessions.set(bob.id, thread.id, "old-session");
    const removed = await remove(bob.id);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().members.map((m: { botId: string }) => m.botId)).toEqual([alice.id]);
    expect(ctx.messages.list(thread.id)).toHaveLength(1);
    expect(ctx.runs.mustGet(parked.id).status).toBe("cancelled");
    expect(ctx.bots.mustGet(bob.id)).toBeDefined();
    expect(ctx.sessions.get(bob.id, thread.id)).toBeUndefined();
    const runsBefore = ctx.runs.list({ threadId: thread.id }).length;
    const aliceRun = ctx.runs.create({
      botId: alice.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: human.message.id,
    });
    const ignoredMention = ctx.router.postFromRun(aliceRun, "@bob review this");
    expect(ignoredMention.mentions).toEqual([]);
    expect(ctx.runs.list({ threadId: thread.id })).toHaveLength(runsBefore + 1);
    expect((await add([bob.id])).statusCode).toBe(200);
    expect(ctx.threads.member(thread.id, bob.id)?.lastSeenSeq).toBe(0);
    expect(ctx.messages.list(thread.id)[0]?.body).toBe("hello group");
  });
});
