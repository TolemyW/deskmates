import { type BotId, RUN_ERROR_TURN_BUDGET, type ThreadMessage } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { openDatabase } from "../db/open.js";
import { EventStore } from "../ledger/events.js";
import { type RunRecord, RunStore } from "../ledger/runs.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { buildDelivery } from "./delivery.js";
import { MessageStore } from "./messages.js";
import { ThreadRouter } from "./router.js";
import { RoutingWalkStore } from "./routing-walks.js";
import { ThreadStore } from "./threads.js";

function setup() {
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceStore(db);
  const bots = new BotStore(db);
  const threads = new ThreadStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const events = new EventStore(db);
  const publishedRuns: RunRecord[] = [];
  const publishedMessages: ThreadMessage[] = [];
  const router = new ThreadRouter(
    threads,
    messages,
    runs,
    () => ({ knob: 1 }),
    new RoutingWalkStore(db),
    events,
    (created) => publishedRuns.push(...created),
    (message) => publishedMessages.push(message),
  );
  const ws = workspaces.create({ name: "w", sandboxProvider: "docker" });
  const alice = bots.create({ name: "alice", role: "a", workspaceId: ws.id });
  const bob = bots.create({ name: "bob", role: "b", workspaceId: ws.id });
  return {
    db,
    workspaces,
    bots,
    threads,
    messages,
    runs,
    router,
    ws,
    alice,
    bob,
    events,
    publishedRuns,
    publishedMessages,
  };
}

describe("thread creation (ADR-0005 item 1)", () => {
  it("defaults kind chat, channel web, turn budget from contracts, title from members", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id, s.bob.id] });
    expect(t).toMatchObject({
      kind: "chat",
      channel: "web",
      turnBudget: 8,
      title: "alice, bob",
      status: "active",
    });
    expect(s.threads.members(t.id).map((m) => [m.name, m.lastSeenSeq])).toEqual([
      ["alice", 0],
      ["bob", 0],
    ]);
  });

  it("rejects a seventh chat member and an empty member list", () => {
    const s = setup();
    const many = Array.from(
      { length: 7 },
      (_, i) => s.bots.create({ name: `b${i}`, role: "r", workspaceId: s.ws.id }).id,
    );
    expect(() => s.threads.create({ workspaceId: s.ws.id, botIds: many })).toThrow(/at most 6/);
    expect(() => s.threads.create({ workspaceId: s.ws.id, botIds: [] })).toThrow(/at least one/);
  });

  it("assigns dense per-thread seq and enforces unique bot names per workspace", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    const t2 = s.threads.create({ workspaceId: s.ws.id, botIds: [s.bob.id] });
    s.messages.append({ threadId: t.id, authorKind: "human", authorId: "h", body: "1" });
    s.messages.append({ threadId: t2.id, authorKind: "human", authorId: "h", body: "x" });
    const m = s.messages.append({ threadId: t.id, authorKind: "human", authorId: "h", body: "2" });
    expect(m.seq).toBe(2);
    expect(() => s.bots.create({ name: "Alice", role: "r", workspaceId: s.ws.id })).toThrow(
      /already exists/,
    );
  });
});

describe("routing (ADR-0005 items 3, 4, 7, 8)", () => {
  it("a one-member thread wakes its member on the interactive lane with trigger_ref = message id", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    const { message, runs } = s.router.postHuman({ threadId: t.id, body: "hello" });
    expect(message).toMatchObject({ seq: 1, relayCount: 0, mentions: [], authorKind: "human" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      botId: s.alice.id,
      threadId: t.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: message.id,
      status: "queued",
      config: { knob: 1 },
    });
  });

  it("stores parsed mentions and wakes each mentioned member once; self-mentions are ignored", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id, s.bob.id] });
    const { message, runs } = s.router.postHuman({
      threadId: t.id,
      body: "@bob and @Alice, @bob again",
    });
    expect(message.mentions).toEqual([
      { kind: "bot", botId: s.bob.id },
      { kind: "bot", botId: s.alice.id },
    ]);
    expect(runs.map((r) => r.botId).sort()).toEqual([s.alice.id, s.bob.id].sort());
  });

  it("a bus thread wakes on the background lane", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id], kind: "bus" });
    const { runs } = s.router.postHuman({ threadId: t.id, body: "job" });
    expect(runs[0]?.lane).toBe("background");
  });

  it("coalesces: a second message while a wake is queued creates no second run", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    const first = s.router.postHuman({ threadId: t.id, body: "@alice one" });
    const second = s.router.postHuman({ threadId: t.id, body: "@alice two" });
    expect(first.runs).toHaveLength(1);
    expect(second.runs).toHaveLength(0);
    expect(s.runs.list({ threadId: t.id })).toHaveLength(1);
    // Once the queued run is running, a new message queues exactly one more wake.
    s.runs.transition(first.runs[0]?.id as never, "running");
    const third = s.router.postHuman({ threadId: t.id, body: "@alice three" });
    expect(third.runs).toHaveLength(1);
    expect(s.router.postHuman({ threadId: t.id, body: "@alice four" }).runs).toHaveLength(0);
  });

  it("a message posted from a run inherits relay_count + 1 and links the run (item 10)", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id, s.bob.id] });
    const { runs } = s.router.postHuman({ threadId: t.id, body: "@alice go" });
    const run = runs[0];
    if (!run) throw new Error("no run");
    const reply = s.router.postFromRun(run, "@bob your turn, not @alice");
    expect(reply).toMatchObject({
      authorKind: "bot",
      authorId: s.alice.id,
      relayCount: 1,
      runId: run.id,
      mentions: [{ kind: "bot", botId: s.bob.id }],
    });
  });
});

describe("durable group routing (ADR-0005 item 4)", () => {
  it("walks join order and does not re-wake members that consumed a queued bot reply", () => {
    const s = setup();
    const carol = s.bots.create({ name: "carol", role: "c", workspaceId: s.ws.id });
    const thread = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id, carol.id],
    });
    const first = s.router.postHuman({ threadId: thread.id, body: "please investigate" });
    const aliceRun = first.runs[0];
    if (!aliceRun) throw new Error("alice was not woken");
    s.runs.transition(aliceRun.id, "running", { deliveredSeq: first.message.seq });
    const reply = s.router.postFromRun(aliceRun, "I found a lead");
    // The later reply walk stays durable without reserving Bob: such a reservation would block
    // Bob's earlier human-message walk and deadlock the two walks behind each other.
    expect(s.runs.list({ threadId: thread.id })).toHaveLength(1);
    const aliceDone = s.runs.transition(aliceRun.id, "succeeded");
    s.threads.advanceLastSeen(thread.id, s.alice.id, first.message.seq);
    const bobRun = s.router.runEnded(aliceDone)[0];
    expect(bobRun?.botId).toBe(s.bob.id);

    if (!bobRun) throw new Error("bob was not woken");
    s.runs.transition(bobRun.id, "running", { deliveredSeq: reply.seq });
    const bobDone = s.runs.transition(bobRun.id, "silent");
    s.threads.advanceLastSeen(thread.id, s.bob.id, reply.seq);
    const carolRun = s.router.runEnded(bobDone)[0];
    expect(carolRun?.botId).toBe(carol.id);

    if (!carolRun) throw new Error("carol was not woken");
    s.runs.transition(carolRun.id, "running", { deliveredSeq: reply.seq });
    const carolDone = s.runs.transition(carolRun.id, "silent");
    s.threads.advanceLastSeen(thread.id, carol.id, reply.seq);
    expect(s.router.runEnded(carolDone)).toEqual([]);
    expect(
      s.runs
        .list({ threadId: thread.id })
        .map((run) => run.botId)
        .sort(),
    ).toEqual([s.alice.id, s.bob.id, carol.id].sort());
  });

  it("a one-member bot reply does not wake its author again", () => {
    const s = setup();
    const thread = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    const posted = s.router.postHuman({ threadId: thread.id, body: "hello" });
    const run = posted.runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running", { deliveredSeq: posted.message.seq });
    s.router.postFromRun(run, "done");
    const done = s.runs.transition(run.id, "succeeded");
    s.threads.advanceLastSeen(thread.id, s.alice.id, posted.message.seq);
    expect(s.router.runEnded(done)).toEqual([]);
    expect(s.runs.list({ threadId: thread.id })).toHaveLength(1);
  });

  it("waits for a busy first member, then resumes when its lane is free", () => {
    const s = setup();
    const other = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    const busy = s.router.postHuman({ threadId: other.id, body: "@alice busy" }).runs[0];
    if (!busy) throw new Error("no busy run");
    s.runs.transition(busy.id, "running");
    const group = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
    });
    expect(s.router.postHuman({ threadId: group.id, body: "who can help?" }).runs).toEqual([]);
    s.runs.transition(busy.id, "failed");
    expect(s.router.continueWalks().map((run) => run.botId)).toEqual([s.alice.id]);
  });

  it("continues a persisted walk after restart finds its active run terminal", () => {
    const s = setup();
    const thread = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
    });
    const first = s.router.postHuman({ threadId: thread.id, body: "walk" }).runs[0];
    if (!first) throw new Error("no first run");
    s.runs.transition(first.id, "running");
    s.runs.transition(first.id, "failed");
    const restarted = new ThreadRouter(
      new ThreadStore(s.db),
      new MessageStore(s.db),
      new RunStore(s.db),
      () => ({ knob: 1 }),
      new RoutingWalkStore(s.db),
    );
    expect(restarted.continueWalks().map((run) => run.botId)).toEqual([s.bob.id]);
  });

  it("a human mention joins a same-workspace bot before routing", () => {
    const s = setup();
    const carol = s.bots.create({ name: "carol", role: "c", workspaceId: s.ws.id });
    const thread = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    const result = s.router.postHuman({ threadId: thread.id, body: "@carol please join" });
    expect(s.threads.members(thread.id).map((member) => member.botId)).toEqual([
      s.alice.id,
      carol.id,
    ]);
    expect(result.runs.map((run) => run.botId)).toEqual([carol.id]);
  });
});

describe("conversation caps (ADR-0005 item 6)", () => {
  it("the budget-th bot message is stored, pauses before another wake, and a human resets it", () => {
    const s = setup();
    const thread = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
      turnBudget: 2,
    });
    const run = s.router.postHuman({ threadId: thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    s.router.postFromRun(run, "@bob first");
    const second = s.router.postFromRun(run, "@bob second");
    expect(second.body).toBe("@bob second");
    expect(s.threads.mustGet(thread.id).status).toBe("paused");
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(1);
    expect(s.events.list(run.id).at(-1)).toMatchObject({
      kind: "cap_breached",
      payload: { cap: "turn_budget", thread_id: thread.id, message_id: second.id },
    });
    expect(s.publishedMessages.at(-1)?.body).toContain("turn budget reached");

    s.router.postHuman({ threadId: thread.id, body: "@alice continue" });
    expect(s.threads.mustGet(thread.id).status).toBe("active");
    // The paused turn's walk was abandoned; resetting starts from this new human message only.
    expect(s.router.continueWalks()).toEqual([]);
  });

  it("names the turn budget as the reason on every queued run the breach cancels", () => {
    const s = setup();
    const thread = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
      turnBudget: 2,
    });
    const run = s.router.postHuman({ threadId: thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    s.router.postFromRun(run, "@bob first");
    const queued = s.runs.list({ botId: s.bob.id });
    expect(queued.map((r) => r.status)).toEqual(["queued"]);
    s.router.postFromRun(run, "@bob second");
    const cancelled = s.runs.mustGet(queued[0]?.id ?? ("" as RunRecord["id"]));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("turn_budget");
    expect(cancelled.error).toBe(RUN_ERROR_TURN_BUDGET);
  });

  it("stores relay six with its forced bus target but creates no wake", () => {
    const s = setup();
    const bus = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
      kind: "bus",
    });
    const trigger = s.messages.append({
      threadId: bus.id,
      authorKind: "bot",
      authorId: s.bob.id,
      body: "five",
      relayCount: 5,
    });
    const run = s.runs.create({
      botId: s.alice.id,
      threadId: bus.id,
      lane: "background",
      triggerKind: "thread_message",
      triggerRef: trigger.id,
    });
    const message = s.router.postFromRunToThread(run, bus.id, "handoff", [], s.bob.id);
    expect(message).toMatchObject({
      relayCount: 6,
      mentions: [{ kind: "bot", botId: s.bob.id }],
    });
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(0);
    expect(s.events.list(run.id).at(-1)?.payload).toMatchObject({ cap: "relay_count" });
  });

  it("inherits the highest relay actually delivered by a coalesced run", () => {
    const s = setup();
    const bus = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
      kind: "bus",
    });
    const trigger = s.messages.append({
      threadId: bus.id,
      authorKind: "human",
      authorId: "operator",
      body: "start",
      relayCount: 0,
    });
    const deep = s.messages.append({
      threadId: bus.id,
      authorKind: "bot",
      authorId: s.bob.id,
      body: "coalesced depth five",
      relayCount: 5,
    });
    const run = s.runs.create({
      botId: s.alice.id,
      threadId: bus.id,
      lane: "background",
      triggerKind: "thread_message",
      triggerRef: trigger.id,
    });
    const delivered = s.runs.transition(run.id, "running", { deliveredSeq: deep.seq });
    const reply = s.router.postFromRunToThread(delivered, bus.id, "reply", [], s.bob.id);
    expect(reply.relayCount).toBe(6);
    expect(s.events.list(run.id).at(-1)?.payload).toMatchObject({ cap: "relay_count" });
  });

  it("a newly delivered human message resets coalesced relay provenance", () => {
    const s = setup();
    const bus = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
      kind: "bus",
    });
    const deep = s.messages.append({
      threadId: bus.id,
      authorKind: "bot",
      authorId: s.bob.id,
      body: "old chain",
      relayCount: 5,
    });
    const reset = s.messages.append({
      threadId: bus.id,
      authorKind: "human",
      authorId: "operator",
      body: "new request",
      relayCount: 0,
    });
    const run = s.runs.create({
      botId: s.alice.id,
      threadId: bus.id,
      lane: "background",
      triggerKind: "thread_message",
      triggerRef: deep.id,
    });
    const delivered = s.runs.transition(run.id, "running", { deliveredSeq: reset.seq });
    const reply = s.router.postFromRunToThread(delivered, bus.id, "fresh reply", [], s.bob.id);
    expect(reply.relayCount).toBe(1);
    expect(s.events.list(run.id)).toEqual([]);
  });
});

// Issue #68 item 2: a bot posting with `thread_post` is told when its mention woke nobody, so it
// does not record success and keep posting into a capped, paused or expired thread.
describe("a bot post reports a wake the Gateway refused", () => {
  function chatRun(s: ReturnType<typeof setup>, turnBudget?: number) {
    const thread = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
      ...(turnBudget === undefined ? {} : { turnBudget }),
    });
    const trigger = s.messages.append({
      threadId: thread.id,
      authorKind: "human",
      authorId: "operator",
      body: "start",
    });
    const run = s.runs.create({
      botId: s.alice.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: trigger.id,
    });
    return { thread, run };
  }

  it("reports nothing when the mention woke its member", () => {
    const s = setup();
    const { run } = chatRun(s);
    const posted = s.router.postFromRunRouted(run, "@bob go");
    expect(posted.wakeBlocked).toBeUndefined();
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(1);
  });

  it("reports the turn budget when this post tripped it", () => {
    const s = setup();
    const { run } = chatRun(s, 2);
    s.router.postFromRunRouted(run, "@bob first");
    const second = s.router.postFromRunRouted(run, "@bob second");
    expect(second.message.body).toBe("@bob second");
    expect(second.wakeBlocked).toBe("turn_budget");
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(1);
  });

  it("reports the relay cap when this post exceeded it", () => {
    const s = setup();
    const bus = s.threads.create({
      workspaceId: s.ws.id,
      botIds: [s.alice.id, s.bob.id],
      kind: "bus",
    });
    const trigger = s.messages.append({
      threadId: bus.id,
      authorKind: "bot",
      authorId: s.bob.id,
      body: "five",
      relayCount: 5,
    });
    const run = s.runs.create({
      botId: s.alice.id,
      threadId: bus.id,
      lane: "background",
      triggerKind: "thread_message",
      triggerRef: trigger.id,
    });
    const posted = s.router.postFromRunRouted(run, "@bob still there?");
    expect(posted.wakeBlocked).toBe("relay_count");
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(0);
  });

  it("reports a paused thread", () => {
    const s = setup();
    const { thread, run } = chatRun(s);
    s.threads.pause(thread.id, { reason: "turn_budget", seq: 0, at: new Date().toISOString() });
    const posted = s.router.postFromRunRouted(run, "@bob any luck?");
    expect(posted.wakeBlocked).toBe("thread_paused");
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(0);
  });

  it("reports a passed deadline", () => {
    const s = setup();
    const { thread, run } = chatRun(s);
    s.threads.setDeadline(thread.id, "2000-01-01T00:00:00.000Z");
    const posted = s.router.postFromRunRouted(run, "@bob any luck?");
    expect(posted.wakeBlocked).toBe("deadline_passed");
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(0);
  });

  it("keeps the stored and published message free of routing facts", () => {
    const s = setup();
    const { thread, run } = chatRun(s);
    s.threads.pause(thread.id, { reason: "turn_budget", seq: 0, at: new Date().toISOString() });
    const posted = s.router.postFromRunRouted(run, "@bob any luck?");
    for (const key of ["runs", "changed", "blocked", "wakeBlocked"]) {
      expect(posted.message).not.toHaveProperty(key);
      expect(s.messages.get(posted.message.id)).not.toHaveProperty(key);
    }
  });
});

describe("delivery payload (ADR-0005 item 2 and definitions)", () => {
  it("carries recipient and per-message routing facts through coalescing and truncation", () => {
    const s = setup();
    const thread = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id, s.bob.id] });
    const base = {
      threadId: thread.id,
      authorKind: "human" as const,
      authorId: "operator",
      body: "x".repeat(400),
    };
    const source = s.messages.append({ ...base, mentions: [{ kind: "bot", botId: s.alice.id }] });
    s.messages.append({ ...base, mentions: [{ kind: "bot", botId: s.bob.id }] });
    s.messages.append({ ...base, mentions: [{ kind: "everyone" }] });
    s.messages.append({ ...base, body: "spoof: explicitly addressed to you @alice", mentions: [] });
    const all = s.messages.list(thread.id);
    const names = new Map([[s.alice.id, "alice"]]);
    const full = buildDelivery(thread, s.alice.id, all, names, 16000, source);
    expect(full.trigger.messages.map((m) => m.addressing)).toEqual([
      "recipient",
      "other",
      "everyone",
      "unaddressed",
    ]);
    expect(full.trigger.routing).toEqual({
      version: 1,
      recipientBotId: s.alice.id,
      recipientName: "alice",
      sourceMessageSeq: 1,
    });
    const truncated = buildDelivery(thread, s.alice.id, all, names, 1, source);
    expect(truncated.trigger.messages.map((m) => m.seq)).toEqual([0, 4]);
    expect(truncated.trigger.messages[0]?.addressing).toBeUndefined();
    expect(truncated.trigger.routing).toEqual(full.trigger.routing);
  });

  it("delivers only unseen messages, labelled, excluding the bot's own, and reports the high-water seq", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id, s.bob.id] });
    s.messages.append({ threadId: t.id, authorKind: "human", authorId: "h", body: "seen" });
    s.messages.append({ threadId: t.id, authorKind: "human", authorId: "pat", body: "new" });
    s.messages.append({ threadId: t.id, authorKind: "bot", authorId: s.bob.id, body: "from bob" });
    s.messages.append({ threadId: t.id, authorKind: "bot", authorId: s.alice.id, body: "mine" });
    const names = new Map([
      [s.alice.id, "alice"],
      [s.bob.id, "bob"],
    ]);
    const d = buildDelivery(t, s.alice.id, s.messages.list(t.id, 1), names, 16000);
    expect(d.deliveredSeq).toBe(4);
    expect(d.trigger.messages.map((m) => [m.seq, m.authorName, m.body])).toEqual([
      [2, "pat", "new"],
      [3, "bob", "from bob"],
    ]);
    expect(d.trigger.thread).toEqual({ id: t.id, kind: "chat", title: t.title });
  });

  it("truncates oldest-first under the token cap and says how many were omitted", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    for (let i = 1; i <= 5; i++) {
      s.messages.append({
        threadId: t.id,
        authorKind: "human",
        authorId: "h",
        body: "x".repeat(400),
      });
    }
    const d = buildDelivery(t, s.alice.id, s.messages.list(t.id, 0), new Map(), 250);
    expect(d.trigger.messages[0]).toMatchObject({
      authorKind: "system",
      body: "3 earlier messages omitted",
    });
    expect(d.trigger.messages.slice(1).map((m) => m.seq)).toEqual([4, 5]);
  });

  it("reports relay provenance only from the newest human chain", () => {
    const s = setup();
    const t = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id, s.bob.id] });
    s.messages.append({
      threadId: t.id,
      authorKind: "bot",
      authorId: s.bob.id,
      body: "old deep chain",
      relayCount: 5,
    });
    s.messages.append({
      threadId: t.id,
      authorKind: "human",
      authorId: "operator",
      body: "reset",
      relayCount: 0,
    });
    s.messages.append({
      threadId: t.id,
      authorKind: "bot",
      authorId: s.bob.id,
      body: "new chain",
      relayCount: 2,
    });
    const delivery = buildDelivery(t, s.alice.id, s.messages.list(t.id), new Map(), 16000);
    expect(delivery.trigger.relayCount).toBe(2);
  });
});

describe("run ledger invariants", () => {
  it("rejects transitions the state machine forbids and stamps timestamps", () => {
    const s = setup();
    const run = s.runs.create({
      botId: s.alice.id as BotId,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "m",
    });
    expect(() => s.runs.transition(run.id, "succeeded")).toThrow(/cannot go from queued/);
    const running = s.runs.transition(run.id, "running");
    expect(running.startedAt).toBeDefined();
    expect(s.runs.laneBusy(s.alice.id, "interactive")).toBe(true);
    expect(s.runs.laneBusy(s.alice.id, "background")).toBe(false);
    const parked = s.runs.transition(run.id, "waiting_approval", {
      resumePayload: { sdkSessionId: "x" },
    });
    expect(parked.resumePayload).toEqual({ sdkSessionId: "x" });
    expect(s.runs.laneBusy(s.alice.id, "interactive")).toBe(false);
    const done = s.runs.transition(run.id, "cancelled");
    expect(done.finishedAt).toBeDefined();
  });

  it("run events keep a monotonic seq and drop redeliveries", () => {
    const s = setup();
    const run = s.runs.create({
      botId: s.alice.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "m",
    });
    // The ledger seq is arrival order for every source; the sidecar seq only detects redelivery.
    expect(s.events.append({ runId: run.id, kind: "log", payload: {}, seq: 1 })?.seq).toBe(1);
    expect(s.events.append({ runId: run.id, kind: "log", payload: {}, seq: 1 })).toBeUndefined();
    expect(s.events.append({ runId: run.id, kind: "log", payload: {} })?.seq).toBe(2);
    expect(s.events.append({ runId: run.id, kind: "log", payload: {}, seq: 5 })?.seq).toBe(3);
    expect(s.events.append({ runId: run.id, kind: "log", payload: {}, seq: 3 })?.seq).toBe(4);
    expect(s.events.append({ runId: run.id, kind: "log", payload: {}, seq: 5 })).toBeUndefined();
    expect(s.events.list(run.id).map((e) => [e.seq, e.sidecarSeq])).toEqual([
      [1, 1],
      [2, undefined],
      [3, 5],
      [4, 3],
    ]);
  });
});
