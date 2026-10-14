// T0/T1: ADR-0005 amendment 2, "an unaddressed request gets one owner", at the router. One
// `describe` per decision; the Gateway-level cases are in `m2-group-foundation.test.ts`.

import type { BotId, GroupRouting, ThreadId, ThreadMessage } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { openDatabase } from "../db/open.js";
import { EventStore } from "../ledger/events.js";
import { type RunRecord, RunStore } from "../ledger/runs.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { MessageStore } from "./messages.js";
import { ThreadRouter } from "./router.js";
import { RoutingWalkStore } from "./routing-walks.js";
import { ThreadStore } from "./threads.js";

function setup(groupRouting: GroupRouting = "owner-v1") {
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceStore(db);
  const bots = new BotStore(db);
  const threads = new ThreadStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const events = new EventStore(db);
  const walks = new RoutingWalkStore(db);
  const publishedMessages: ThreadMessage[] = [];
  const changedThreads: ThreadId[] = [];
  const router = new ThreadRouter(
    threads,
    messages,
    runs,
    () => ({ groupRouting }),
    walks,
    events,
    () => {},
    (message) => publishedMessages.push(message),
    { groupRouting, onThreadChanged: (threadId) => changedThreads.push(threadId) },
  );
  const ws = workspaces.create({ name: "w", sandboxProvider: "docker" });
  const alice = bots.create({ name: "alice", role: "pricing analyst", workspaceId: ws.id });
  const bob = bots.create({ name: "bob", role: "coordinator", workspaceId: ws.id });
  const carol = bots.create({ name: "carol", role: "stock keeper", workspaceId: ws.id });
  const thread = threads.create({ workspaceId: ws.id, botIds: [alice.id, bob.id, carol.id] });

  /** Start a queued run and deliver it everything posted so far. */
  const start = (run: RunRecord): RunRecord =>
    runs.transition(run.id, "running", { deliveredSeq: messages.maxSeq(run.threadId as ThreadId) });
  /** End a run the way the lifecycle does: the cursor moves unless it failed, then the walk. */
  const end = (
    run: RunRecord,
    status: "succeeded" | "silent" | "failed" | "cancelled",
  ): RunRecord[] => {
    const current = runs.mustGet(run.id);
    const done = runs.transition(run.id, status);
    if (status === "succeeded" || status === "silent") {
      threads.advanceLastSeen(done.threadId as ThreadId, done.botId, current.deliveredSeq ?? 0);
    }
    return router.runEnded(done);
  };
  const botOf = (run: RunRecord | undefined): BotId | undefined => run?.botId;
  return {
    db,
    bots,
    threads,
    messages,
    runs,
    events,
    walks,
    router,
    ws,
    alice,
    bob,
    carol,
    thread,
    publishedMessages,
    changedThreads,
    start,
    end,
    botOf,
  };
}

function only(runs: readonly RunRecord[]): RunRecord {
  const [run] = runs;
  if (!run || runs.length !== 1) throw new Error(`expected one run, got ${runs.length}`);
  return run;
}

describe("the offer ends with the first taker (decision 14)", () => {
  it("wakes one member, and nobody else once that member posts", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "What is the stock worth?" });
    const first = only(posted.runs);
    expect(first.botId).toBe(s.alice.id);
    const running = s.start(first);
    s.router.postFromRun(running, "I will work it out.");
    expect(s.walks.mustGet(posted.message.id)).toMatchObject({
      status: "complete",
      mode: "first_taker",
      takerBotId: s.alice.id,
    });
    expect(s.end(first, "succeeded")).toEqual([]);
    expect(s.runs.list({ threadId: s.thread.id }).map((r) => r.botId)).toEqual([s.alice.id]);
    // The members never offered still get the request, with their next wake.
    expect(s.threads.member(s.thread.id, s.bob.id)?.lastSeenSeq).toBe(0);
  });

  it("moves to the next member when one ends silent, failed or cancelled", () => {
    for (const status of ["silent", "failed", "cancelled"] as const) {
      const s = setup();
      const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
      const first = only(posted.runs);
      s.start(first);
      const next = only(s.end(first, status));
      expect(next.botId).toBe(s.bob.id);
      expect(next.triggerRef).toBe(posted.message.id);
      expect(s.walks.mustGet(posted.message.id).status).toBe("pending");
    }
  });

  it("a member that hands the request to a teammate by mention has taken it", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "count the stock" });
    const first = s.start(only(posted.runs));
    s.router.postFromRun(first, "@carol this is yours: count item K and report back.");
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.alice.id);
    expect(s.runs.findQueued(s.carol.id, s.thread.id)).toBeDefined();
    expect(s.end(first, "silent")).toEqual([]);
    expect(s.runs.findQueued(s.bob.id, s.thread.id)).toBeUndefined();
  });

  it("a message_bot handoff from the offered run takes the request", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "ask carol privately" });
    const first = s.start(only(posted.runs));
    s.router.handedOff(first);
    expect(s.walks.mustGet(posted.message.id).takerBotId).toBe(s.alice.id);
    expect(s.end(first, "silent")).toEqual([]);
  });

  it("a member that saw the request in an earlier run and wrote after it is its taker", () => {
    const s = setup();
    const one = s.router.postHuman({ threadId: s.thread.id, body: "first question" });
    const two = s.router.postHuman({ threadId: s.thread.id, body: "and a second one" });
    expect(two.runs).toEqual([]);
    // Alice's run starts after both were posted, so it delivers both and answers them together.
    const run = s.start(only(one.runs));
    s.router.postFromRun(run, "Both answered.");
    expect(s.end(run, "succeeded")).toEqual([]);
    expect(s.walks.mustGet(two.message.id)).toMatchObject({
      status: "complete",
      takerBotId: s.alice.id,
    });
    expect(s.runs.list({ threadId: s.thread.id })).toHaveLength(1);
  });

  it("a post from a run that started before the request existed does not answer it", () => {
    const s = setup();
    s.threads.setOwner(s.thread.id, s.alice.id);
    const addressed = s.router.postHuman({ threadId: s.thread.id, body: "@bob check X" });
    const early = s.start(only(addressed.runs));
    const request = s.router.postHuman({ threadId: s.thread.id, body: "What is the stock worth?" });
    const offered = s.start(only(request.runs));
    expect(offered.botId).toBe(s.alice.id);
    // Bob's earlier run never saw the request; its answer is about something else.
    s.router.postFromRun(early, "X is fine.");
    s.end(early, "succeeded");
    // Bob then reads the request in a run woken by something else and says nothing.
    const woken = only(
      s.router.postSystem(s.thread.id, "note for bob", [], { wakeOnly: s.bob.id }).runs,
    );
    s.start(woken);
    s.end(woken, "silent");
    // Alice passes. Bob saw the request and did not answer it, so it moves on to carol.
    const next = only(s.end(offered, "silent"));
    expect(next.botId).toBe(s.carol.id);
    expect(s.walks.mustGet(request.message.id)).toMatchObject({ status: "pending" });
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.alice.id);
  });

  it("a human message in a bus thread is walked as before and names no owner", () => {
    const s = setup();
    const bus = s.threads.create({
      workspaceId: s.ws.id,
      kind: "bus",
      botIds: [s.alice.id, s.bob.id],
    });
    const posted = s.router.postHuman({ threadId: bus.id, body: "operator note" });
    expect(s.walks.mustGet(posted.message.id).mode).toBe("all");
    s.router.postHuman({ threadId: bus.id, body: "@bob look" });
    expect(s.threads.mustGet(bus.id).ownerBotId).toBeUndefined();
  });

  it("@everyone wakes every member at once and makes no owner (ADR-0005 amendment 4)", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@everyone status please" });
    expect(posted.runs.map((run) => run.botId)).toEqual([s.alice.id, s.bob.id, s.carol.id]);
    s.router.postFromRun(s.start(posted.runs[0] as RunRecord), "alice: fine");
    expect(s.walks.get(posted.message.id)).toBeUndefined();
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBeUndefined();
  });

  it("a sequential @everyone still wakes every member in turn, whoever answers", () => {
    const s = setup();
    const posted = s.router.postHuman({
      threadId: s.thread.id,
      body: "@everyone status please",
      roundMode: "sequential",
    });
    const first = s.start(only(posted.runs));
    s.router.postFromRun(first, "alice: fine");
    const second = only(s.end(first, "succeeded"));
    expect(second.botId).toBe(s.bob.id);
    s.start(second);
    expect(s.botOf(only(s.end(second, "silent")))).toBe(s.carol.id);
    expect(s.walks.mustGet(posted.message.id).mode).toBe("all");
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBeUndefined();
  });

  it("a one-member chat is untouched: no offer, no owner, no extra event", () => {
    const s = setup();
    const solo = s.threads.create({ workspaceId: s.ws.id, botIds: [s.alice.id] });
    const posted = s.router.postHuman({ threadId: solo.id, body: "hello" });
    const run = s.start(only(posted.runs));
    s.router.postFromRun(run, "hi");
    expect(s.walks.mustGet(posted.message.id).mode).toBe("all");
    expect(s.threads.mustGet(solo.id).ownerBotId).toBeUndefined();
    expect(s.events.list(run.id)).toEqual([]);
    expect(s.changedThreads).toEqual([]);
  });
});

describe("the taker owns the thread (decision 15)", () => {
  it("records the first taker, logs it on the run and tells operator clients", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "who takes this?" });
    const first = only(posted.runs);
    s.start(first);
    const second = s.start(only(s.end(first, "silent")));
    s.router.postFromRun(second, "Mine.");
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.bob.id);
    expect(s.changedThreads).toEqual([s.thread.id]);
    expect(s.events.list(second.id).map((e) => e.payload)).toEqual([
      {
        source: "group_owner",
        threadId: s.thread.id,
        messageId: posted.message.id,
        ownerBotId: s.bob.id,
        changed: true,
      },
    ]);
  });

  it("a human who addresses one bot names the owner only while there is none", () => {
    const s = setup();
    s.router.postHuman({ threadId: s.thread.id, body: "@bob @carol both of you" });
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBeUndefined();
    s.router.postHuman({ threadId: s.thread.id, body: "@carol count item K" });
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.carol.id);
    s.router.postHuman({ threadId: s.thread.id, body: "@alice what is the price?" });
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.carol.id);
  });

  it("is replaced by the taker of a later request and cleared when the owner leaves", () => {
    const s = setup();
    s.router.postHuman({ threadId: s.thread.id, body: "@carol count item K" });
    for (const queued of s.runs.listQueuedInThread(s.thread.id)) {
      s.start(queued);
      s.end(queued, "silent");
    }
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "and the total value?" });
    const offered = only(posted.runs);
    expect(offered.botId).toBe(s.carol.id);
    s.start(offered);
    const next = s.start(only(s.end(offered, "silent")));
    expect(next.botId).toBe(s.alice.id);
    s.router.postFromRun(next, "I have it.");
    s.end(next, "succeeded");
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.alice.id);
    expect(s.threads.removeMember(s.thread.id, s.alice.id)).toBe(true);
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBeUndefined();
  });

  it("is not access control: any member may still post, mention and be addressed", () => {
    const s = setup();
    s.router.postHuman({ threadId: s.thread.id, body: "@bob coordinate this" });
    const bobRun = s.start(s.runs.findQueued(s.bob.id, s.thread.id) as RunRecord);
    s.router.postFromRun(bobRun, "@carol count item K");
    const carolRun = s.start(s.runs.findQueued(s.carol.id, s.thread.id) as RunRecord);
    // Carol is not the owner and asks Alice directly.
    s.router.postFromRun(carolRun, "@alice what is the unit price?");
    expect(s.runs.findQueued(s.alice.id, s.thread.id)).toBeDefined();
    const direct = s.router.postHuman({ threadId: s.thread.id, body: "@alice and the currency?" });
    expect(direct.message.mentions).toEqual([{ kind: "bot", botId: s.alice.id }]);
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.bob.id);
  });
});

describe("the owner is offered first (decision 16)", () => {
  it("starts the next unaddressed request with the owner, then join order", () => {
    const s = setup();
    s.threads.setOwner(s.thread.id, s.carol.id);
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "follow-up" });
    expect(only(posted.runs).botId).toBe(s.carol.id);
    expect(s.walks.members(posted.message.id)).toEqual([s.carol.id, s.alice.id, s.bob.id]);
  });

  it("a follow-up the owner takes costs one run", () => {
    const s = setup();
    s.threads.setOwner(s.thread.id, s.bob.id);
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "and in euros?" });
    const run = s.start(only(posted.runs));
    s.router.postFromRun(run, "In euros it is 12.");
    expect(s.end(run, "succeeded")).toEqual([]);
    expect(s.runs.list({ threadId: s.thread.id })).toHaveLength(1);
  });

  it("an owner busy when the request arrives is offered it once its lane is free", () => {
    const s = setup();
    const one = s.router.postHuman({ threadId: s.thread.id, body: "first" });
    const run = s.start(only(one.runs));
    s.router.postFromRun(run, "On it.");
    // Alice owns the thread and is still running when the second request arrives.
    const two = s.router.postHuman({ threadId: s.thread.id, body: "second" });
    expect(two.runs).toEqual([]);
    const next = only(s.end(run, "succeeded"));
    expect(next.botId).toBe(s.alice.id);
    expect(next.triggerRef).toBe(two.message.id);
  });
});

describe("an unaddressed bot message wakes nobody in a chat thread (decision 17)", () => {
  it("creates no run and no walk; a mention still wakes its target", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@bob summarize" });
    const run = s.start(only(posted.runs));
    const summary = s.router.postFromRun(run, "Here is the summary.");
    expect(s.walks.get(summary.id)).toBeUndefined();
    expect(s.runs.list({ threadId: s.thread.id })).toHaveLength(1);
    s.router.postFromRun(run, "@alice check the numbers");
    expect(s.runs.findQueued(s.alice.id, s.thread.id)).toBeDefined();
  });

  it("a bot's @everyone consults the other members at once (ADR-0005 amendment 4)", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@bob ask around" });
    const run = s.start(only(posted.runs));
    const asked = s.router.postFromRun(run, "@everyone who has the login?");
    expect(s.walks.get(asked.id)).toBeUndefined();
    const woken = s.runs.list({ threadId: s.thread.id }).filter((r) => r.triggerRef === asked.id);
    // Woken at once: their runs share a creation time, so the list order is not part of the contract.
    expect(woken.map((r) => r.botId).sort()).toEqual([s.alice.id, s.carol.id].sort());
  });

  it("in a bus thread the other member is still woken", () => {
    const s = setup();
    const bus = s.threads.create({
      workspaceId: s.ws.id,
      kind: "bus",
      botIds: [s.alice.id, s.bob.id],
    });
    const seed = s.runs.create({
      botId: s.alice.id,
      threadId: s.thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "seed",
      config: {},
    });
    const asked = s.router.postFromRunToThread(seed, bus.id, "need the price", [], s.bob.id);
    const bobRun = s.start(s.runs.findQueued(s.bob.id, bus.id) as RunRecord);
    expect(bobRun.triggerRef).toBe(asked.id);
    s.router.postFromRun(bobRun, "The price is 4.");
    expect(s.runs.findQueued(s.alice.id, bus.id)).toBeDefined();
  });
});

describe("a request nobody took is said so (decision 18)", () => {
  it("posts one system line naming how each member ended, and wakes nobody", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    const a = only(posted.runs);
    s.start(a);
    const b = only(s.end(a, "silent"));
    s.start(b);
    const c = only(s.end(b, "failed"));
    s.start(c);
    expect(s.end(c, "silent")).toEqual([]);
    const last = s.messages.list(s.thread.id).at(-1);
    expect(last).toMatchObject({
      authorKind: "system",
      body: `No member replied to message #${posted.message.seq}: alice ended without a reply; bob failed; carol ended without a reply. Mention a member to assign it.`,
    });
    expect(s.publishedMessages.map((m) => m.id)).toEqual([last?.id]);
    expect(s.runs.listQueued()).toEqual([]);
    expect(s.walks.mustGet(posted.message.id)).toMatchObject({ status: "complete" });
    expect(s.walks.mustGet(posted.message.id).takerBotId).toBeUndefined();
  });

  it("names a member that passed and was then removed", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    const a = only(posted.runs);
    s.start(a);
    const b = only(s.end(a, "silent"));
    s.threads.removeMember(s.thread.id, s.alice.id);
    s.start(b);
    const c = only(s.end(b, "silent"));
    s.start(c);
    s.end(c, "silent");
    expect(s.messages.list(s.thread.id).at(-1)?.body).toContain(
      "alice ended without a reply; bob ended without a reply; carol ended without a reply",
    );
  });

  it("says nothing after an @everyone walk", () => {
    const s = setup();
    const posted = s.router.postHuman({
      threadId: s.thread.id,
      body: "@everyone fyi",
      roundMode: "sequential",
    });
    let next: RunRecord | undefined = only(posted.runs);
    while (next) {
      s.start(next);
      next = s.end(next, "silent")[0];
    }
    expect(s.messages.list(s.thread.id)).toHaveLength(1);
  });
});

describe("walk-v1 is decision 4 as first written (the knob)", () => {
  it("walks every member after an answer, walks a bot reply, and records no owner", () => {
    const s = setup("walk-v1");
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@alice and then?" });
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBeUndefined();
    const run = s.start(only(posted.runs));
    const reply = s.router.postFromRun(run, "Done.");
    expect(s.walks.mustGet(reply.id).mode).toBe("all");
    s.end(run, "succeeded");
    const open = s.router.postHuman({ threadId: s.thread.id, body: "unaddressed" });
    expect(s.walks.mustGet(open.message.id).mode).toBe("all");
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBeUndefined();
    expect(s.changedThreads).toEqual([]);
  });
});
