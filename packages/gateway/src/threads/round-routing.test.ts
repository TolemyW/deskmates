// T1: ADR-0005 amendment 6 (proposed) — `round-v1` at the router with the stores it writes:
// triage instead of the offer, parallel assigned work, one closer wake, per-round turn budget and
// spaced mentions. Runs are moved through their states by hand, as the lifecycle would; the triage
// job's answer is stored the way `RoundTriage.complete` stores it. No sidecar, no model.

import type { BotId, GroupRouting, MessageId, ThreadId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { BudgetStore } from "../budget/budget-store.js";
import { openDatabase } from "../db/open.js";
import { EventStore } from "../ledger/events.js";
import { type RunRecord, RunStore } from "../ledger/runs.js";
import { WorkspaceLimitStore } from "../limits/workspace-limits.js";
import { ROUND_TRIAGE, roundTriageRequester } from "../model-jobs/round-triage.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { MessageStore } from "./messages.js";
import { cancelRound } from "./round-cancel.js";
import { RoundPlanStore } from "./round-plans.js";
import { RoundStore } from "./rounds.js";
import { ThreadRouter } from "./router.js";
import { RoutingWalkStore } from "./routing-walks.js";
import { ThreadStore } from "./threads.js";

function setup(groupRouting: GroupRouting = "round-v1", opts: { triage?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceStore(db);
  const bots = new BotStore(db);
  const threads = new ThreadStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const walks = new RoutingWalkStore(db);
  const rounds = new RoundStore(db);
  const plans = new RoundPlanStore(db);
  const events = new EventStore(db);
  const limits = new WorkspaceLimitStore(db, new BudgetStore(db), () => 80);
  const runConfig = () => ({ groupRouting });
  const router = new ThreadRouter(
    threads,
    messages,
    runs,
    runConfig,
    walks,
    events,
    () => {},
    () => {},
    {
      groupRouting,
      rounds,
      limits,
      roundPlans: plans,
      ...(opts.triage === false
        ? {}
        : {
            triage: roundTriageRequester({
              runs,
              bots,
              runConfig,
              cheapModel: () => "test-model-cheap",
            }),
          }),
    },
  );
  const ws = workspaces.create({ name: "w", sandboxProvider: "docker" });
  const [ann, ben, cat, dan] = ["ann", "ben", "cat", "dan"].map((name) =>
    bots.create({ name, role: `${name} role`, workspaceId: ws.id }),
  ) as [
    ReturnType<BotStore["create"]>,
    ReturnType<BotStore["create"]>,
    ReturnType<BotStore["create"]>,
    ReturnType<BotStore["create"]>,
  ];
  const thread = threads.create({ workspaceId: ws.id, botIds: [ann.id, ben.id, cat.id, dan.id] });
  const start = (run: RunRecord): RunRecord =>
    runs.transition(run.id, "running", { deliveredSeq: messages.maxSeq(run.threadId as ThreadId) });
  const end = (
    run: RunRecord,
    status: "succeeded" | "silent" | "failed" | "cancelled" | "stopped",
  ): RunRecord[] => {
    const current = runs.mustGet(run.id);
    // A run is stopped only from a parked continuation (ADR-0016 decision 4).
    if (status === "stopped") runs.transition(run.id, "waiting_continuation");
    const done = runs.transition(run.id, status);
    if (status === "succeeded" || status === "silent")
      threads.advanceLastSeen(done.threadId as ThreadId, done.botId, current.deliveredSeq ?? 0);
    return router.runEnded(done);
  };
  /** A model job is delivered no slice and moves no cursor: started and ended as the lifecycle does. */
  const endTriage = (
    triage: RunRecord,
    status: "succeeded" | "failed" | "cancelled",
  ): RunRecord[] => {
    if (status !== "cancelled") runs.transition(triage.id, "running");
    return router.runEnded(runs.transition(triage.id, status));
  };
  /** The triage job answered: store its plan as `RoundTriage.complete` does, then end it. */
  const triaged = (
    triage: RunRecord,
    assignments: [BotId, string][],
    closer: BotId,
  ): RunRecord[] => {
    const messageId = triage.config.roundMessageId as MessageId;
    plans.storeAssignments(
      messageId,
      assignments.map(([botId, task]) => ({ botId, task })),
      closer,
    );
    return endTriage(triage, "succeeded");
  };
  const memberRuns = (messageId: MessageId) =>
    runs.list({ threadId: thread.id }).filter((r) => r.triggerRef === messageId);
  const stateOf = (messageId: MessageId) =>
    Object.fromEntries(
      (rounds.get(messageId)?.members ?? []).map((m) => [bots.mustGet(m.botId).name, m.state]),
    );
  const only = (list: readonly RunRecord[]): RunRecord => {
    const [run] = list;
    if (!run || list.length !== 1) throw new Error(`expected one run, got ${list.length}`);
    return run;
  };
  const named = (list: readonly RunRecord[]) => list.map((r) => bots.mustGet(r.botId).name).sort();
  return {
    db,
    bots,
    threads,
    messages,
    runs,
    walks,
    rounds,
    plans,
    events,
    limits,
    router,
    ws,
    ann,
    ben,
    cat,
    dan,
    thread,
    start,
    end,
    endTriage,
    triaged,
    memberRuns,
    stateOf,
    only,
    named,
  };
}

/** A round whose triage assigned ben and cat with dan closing, and their two runs. */
function dispatched() {
  const s = setup();
  const posted = s.router.postHuman({ threadId: s.thread.id, body: "Price and stock of item K?" });
  const triage = s.only(posted.runs);
  const work = s.triaged(
    triage,
    [
      [s.ben.id, "look up the price"],
      [s.cat.id, "look up the stock"],
    ],
    s.dan.id,
  );
  const ben = work.find((r) => r.botId === s.ben.id) as RunRecord;
  const cat = work.find((r) => r.botId === s.cat.id) as RunRecord;
  return { s, message: posted.message, triage, work, ben, cat };
}

describe("a human request to the group is triaged (decision 44)", () => {
  it("queues one triage job and no member run for an unaddressed message", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "What is item K worth?" });
    const triage = s.only(posted.runs);
    expect(triage).toMatchObject({
      botId: s.ann.id,
      threadId: s.thread.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: `${ROUND_TRIAGE}:${posted.message.id}`,
    });
    expect(triage.config).toMatchObject({
      runType: ROUND_TRIAGE,
      roundMessageId: posted.message.id,
      model: "test-model-cheap",
      cheapModel: "test-model-cheap",
      maxTurns: 1,
      groupRouting: "round-v1",
    });
    expect(s.plans.get(posted.message.id)).toMatchObject({
      phase: "triage",
      triageRunId: triage.id,
    });
    const round = s.rounds.get(posted.message.id);
    expect(round?.mode).toBe("offer");
    expect(round?.members.map((m) => m.botId)).toEqual([s.ann.id, s.ben.id, s.cat.id, s.dan.id]);
    expect(round?.plan?.phase).toBe("triage");
    expect(s.walks.get(posted.message.id)).toBeUndefined();
  });

  it("triages @everyone too, whatever round mode was asked for, as a parallel round", () => {
    const s = setup();
    const posted = s.router.postHuman({
      threadId: s.thread.id,
      body: "@everyone status please",
      roundMode: "sequential",
    });
    expect(s.only(posted.runs).config.runType).toBe(ROUND_TRIAGE);
    expect(s.rounds.get(posted.message.id)?.mode).toBe("parallel");
  });

  it("runs the triage as the owner when the thread has one", () => {
    const s = setup();
    s.threads.setOwner(s.thread.id, s.cat.id);
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "next?" });
    expect(s.only(posted.runs).botId).toBe(s.cat.id);
  });

  it("wakes an explicitly mentioned bot directly and makes no plan", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@ben the price?" });
    const run = s.only(posted.runs);
    expect(run.botId).toBe(s.ben.id);
    expect(run.config.runType).toBeUndefined();
    expect(s.plans.get(posted.message.id)).toBeUndefined();
  });

  it("keeps a bot's @everyone as parallel consultation with no triage", () => {
    const s = setup();
    const first = s.only(s.router.postHuman({ threadId: s.thread.id, body: "@ann go" }).runs);
    const running = s.start(first);
    s.router.postFromRun(running, "@everyone what do you each know?");
    const woken = s.runs
      .list({ threadId: s.thread.id })
      .filter((r) => r.id !== first.id && r.status === "queued");
    expect(s.named(woken)).toEqual(["ben", "cat", "dan"]);
    expect(woken.every((r) => r.config.runType === undefined)).toBe(true);
  });

  it("routes a one-member thread as owner-v1 does", () => {
    const s = setup();
    const solo = s.threads.create({ workspaceId: s.ws.id, botIds: [s.ann.id] });
    const posted = s.router.postHuman({ threadId: solo.id, body: "hello" });
    const run = s.only(posted.runs);
    expect(run.botId).toBe(s.ann.id);
    expect(run.config.runType).toBeUndefined();
    expect(s.plans.get(posted.message.id)).toBeUndefined();
  });
});

describe("the assigned members work in parallel (decision 47)", () => {
  it("wakes exactly the assigned members at once and makes the closer the owner", () => {
    const { s, message, work } = dispatched();
    expect(s.named(work)).toEqual(["ben", "cat"]);
    expect(work.every((r) => r.status === "queued" && r.triggerRef === message.id)).toBe(true);
    expect(s.plans.get(message.id)?.phase).toBe("working");
    expect(s.threads.mustGet(s.thread.id).ownerBotId).toBe(s.dan.id);
    expect(s.stateOf(message.id)).toEqual({
      ann: "skipped",
      ben: "queued",
      cat: "queued",
      dan: "skipped",
    });
    const round = s.rounds.get(message.id);
    expect(round?.plan).toMatchObject({
      phase: "working",
      closerBotId: s.dan.id,
      assignments: [
        { botId: s.ben.id, task: "look up the price" },
        { botId: s.cat.id, task: "look up the stock" },
      ],
    });
    expect(round?.members.find((m) => m.botId === s.ben.id)?.runs).toEqual([
      { runId: work.find((r) => r.botId === s.ben.id)?.id, relation: "created" },
    ]);
  });

  it("coalesces an assignment into a member's queued wake", () => {
    const s = setup();
    const direct = s.only(s.router.postHuman({ threadId: s.thread.id, body: "@ben hi" }).runs);
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "Price of K?" });
    const work = s.triaged(s.only(posted.runs), [[s.ben.id, "price"]], s.ben.id);
    expect(work).toEqual([]);
    expect(
      s.rounds.get(posted.message.id)?.members.find((m) => m.botId === s.ben.id)?.runs,
    ).toEqual([{ runId: direct.id, relation: "coalesced" }]);
  });
});

describe("triage falls back to today's routing (decision 46)", () => {
  it("offers an unaddressed message owner first when the triage run fails", () => {
    const s = setup();
    s.threads.setOwner(s.thread.id, s.cat.id);
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    const offered = s.only(s.endTriage(s.only(posted.runs), "failed"));
    expect(offered.botId).toBe(s.cat.id);
    expect(s.walks.get(posted.message.id)).toMatchObject({ mode: "first_taker" });
    expect(s.plans.get(posted.message.id)).toMatchObject({ phase: "fallback" });
    expect(s.plans.get(posted.message.id)?.reason).toMatch(/triage failed/);
  });

  it("falls back when the job succeeded with no assignment of a current member", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    const offered = s.only(s.endTriage(s.only(posted.runs), "succeeded"));
    expect(offered.botId).toBe(s.ann.id);
    expect(s.plans.get(posted.message.id)?.reason).toMatch(/no current member/);
  });

  it("wakes every member at once for @everyone when triage fails", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@everyone report" });
    expect(s.named(s.endTriage(s.only(posted.runs), "failed"))).toEqual([
      "ann",
      "ben",
      "cat",
      "dan",
    ]);
  });

  it("falls back at once in a router with no triage job", () => {
    const s = setup("round-v1", { triage: false });
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    expect(s.only(posted.runs).botId).toBe(s.ann.id);
    expect(s.plans.get(posted.message.id)?.phase).toBe("fallback");
  });

  it("wakes nobody when the triage run is cancelled", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    expect(s.endTriage(s.only(posted.runs), "cancelled")).toEqual([]);
    expect(s.plans.get(posted.message.id)?.phase).toBe("closed");
    expect(s.walks.get(posted.message.id)).toBeUndefined();
  });

  it("a cancelled round takes its triage job with it and wakes nobody", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    const triage = s.only(posted.runs);
    const result = cancelRound(
      {
        rounds: s.rounds,
        runs: s.runs,
        walks: s.walks,
        plans: s.plans,
        cancelRun: (id) => {
          s.router.runEnded(s.runs.transition(id, "cancelled"));
        },
      },
      posted.message.id,
      "user:op",
    );
    expect(result.cancelled).toEqual([triage.id]);
    expect(s.runs.list({ threadId: s.thread.id }).every((r) => r.id === triage.id)).toBe(true);
  });
});

describe("one closer wake after every assigned run ended (decision 48)", () => {
  for (const last of ["succeeded", "silent", "failed", "cancelled", "stopped"] as const) {
    it(`wakes the closer exactly once when the last assigned run ends ${last}`, () => {
      const { s, message, ben, cat } = dispatched();
      const benRunning = s.start(ben);
      s.router.postFromRun(benRunning, "K costs 5.");
      expect(s.end(ben, "succeeded")).toEqual([]);
      if (last !== "cancelled") s.start(cat);
      const closer = s.only(s.end(cat, last));
      expect(closer).toMatchObject({ botId: s.dan.id, triggerRef: message.id, status: "queued" });
      expect(s.plans.get(message.id)).toMatchObject({ phase: "closing", closerRunId: closer.id });
      const close = s.events.list(closer.id).find((e) => e.payload.source === "round_close");
      expect(close?.payload).toMatchObject({ messageId: message.id, closerBotId: s.dan.id });
      // Nothing that ends later wakes it again.
      s.start(closer);
      s.router.postFromRun(s.runs.mustGet(closer.id), "K: price 5, stock 10.");
      expect(s.end(closer, "succeeded")).toEqual([]);
      expect(s.plans.get(message.id)?.phase).toBe("closed");
      expect(
        s.runs.list({ threadId: s.thread.id }).filter((r) => r.botId === s.dan.id),
      ).toHaveLength(1);
      expect(s.rounds.get(message.id)?.plan?.synthesisMessageIds).toHaveLength(1);
    });
  }

  it("waits while an assigned run is parked", () => {
    const { s, ben, cat } = dispatched();
    s.start(ben);
    s.end(ben, "succeeded");
    s.start(cat);
    const parked = s.runs.transition(cat.id, "waiting_approval");
    expect(s.router.runEnded(parked)).toEqual([]);
    expect(s.runs.list({ threadId: s.thread.id }).some((r) => r.botId === s.dan.id)).toBe(false);
  });

  it("reuses the closer's queued wake instead of queueing a second", () => {
    const { s, message, ben, cat } = dispatched();
    const queued = s.only(s.router.postHuman({ threadId: s.thread.id, body: "@dan hold on" }).runs);
    s.start(ben);
    s.end(ben, "succeeded");
    s.start(cat);
    expect(s.end(cat, "succeeded")).toEqual([]);
    expect(s.plans.get(message.id)).toMatchObject({ phase: "closing", closerRunId: queued.id });
  });

  it("makes no closer wake when the closer was the only assignee", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "Stock of Q?" });
    const run = s.only(s.triaged(s.only(posted.runs), [[s.cat.id, "count Q"]], s.cat.id));
    s.start(run);
    expect(s.end(run, "succeeded")).toEqual([]);
    expect(s.plans.get(posted.message.id)?.phase).toBe("closed");
  });

  it("does not wake the closer of a paused thread", () => {
    const { s, message, ben, cat } = dispatched();
    s.start(ben);
    s.end(ben, "succeeded");
    s.threads.setStatus(s.thread.id, "paused");
    s.start(cat);
    expect(s.end(cat, "succeeded")).toEqual([]);
    expect(s.plans.get(message.id)?.phase).toBe("closed");
  });

  it("a retry after the close does not wake the closer again", () => {
    const { s, message, ben, cat } = dispatched();
    s.start(ben);
    s.end(ben, "succeeded");
    s.start(cat);
    const closer = s.only(s.end(cat, "failed"));
    const retry = s.router.retryRoundMember(message.id, s.cat.id);
    expect(retry.created).toBe(true);
    s.start(retry.run);
    expect(s.end(retry.run, "succeeded")).toEqual([]);
    expect(s.plans.get(message.id)?.closerRunId).toBe(closer.id);
  });
});

describe("the turn budget counts a round once (decision 49)", () => {
  it("does not pause on many posts of one round, and owner-v1 still counts each", () => {
    const { s, ben, cat } = dispatched();
    s.limits.set(s.ws.id, { turnBudget: 3 }, "user:admin");
    const b = s.start(ben);
    const c = s.start(cat);
    for (const text of ["checking", "found it", "K costs 5"]) s.router.postFromRun(b, text);
    for (const text of ["counting", "K: 10 in stock"]) s.router.postFromRun(c, text);
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
    expect(s.plans.botCountByRound(s.thread.id)).toBe(1);

    const o = setup("owner-v1");
    o.limits.set(o.ws.id, { turnBudget: 3 }, "user:admin");
    const run = o.start(
      o.only(o.router.postHuman({ threadId: o.thread.id, body: "@ben go" }).runs),
    );
    for (const text of ["checking", "found it", "K costs 5"]) o.router.postFromRun(run, text);
    expect(o.threads.mustGet(o.thread.id).status).toBe("paused");
  });

  it("counts a bot message outside the round on its own", () => {
    const { s, ben } = dispatched();
    const b = s.start(ben);
    s.router.postFromRun(b, "one");
    s.router.postFromRun(b, "two");
    const outside = s.start(
      s.only(s.router.postHuman({ threadId: s.thread.id, body: "@ann note" }).runs),
    );
    // A human message moves the budget origin; count again from it.
    s.router.postFromRun(outside, "noted");
    s.router.postFromRun(b, "three");
    expect(s.plans.botCountByRound(s.thread.id)).toBe(2);
  });
});

describe("`@ name` is a mention under round-v1 (decision 50)", () => {
  it("wakes a member written with a space, and owner-v1 does not", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@ ben the price?" });
    expect(s.only(posted.runs).botId).toBe(s.ben.id);
    expect(posted.message.mentions).toEqual([{ kind: "bot", botId: s.ben.id }]);

    const o = setup("owner-v1");
    const strict = o.router.postHuman({ threadId: o.thread.id, body: "@ ben the price?" });
    expect(strict.message.mentions).toEqual([]);
  });

  it("reads a bot's spaced hand-off as a mention and ignores a spaced unknown name", () => {
    const s = setup();
    const run = s.start(
      s.only(s.router.postHuman({ threadId: s.thread.id, body: "@ann go" }).runs),
    );
    const handoff = s.router.postFromRun(run, "@ cat please count, and @ zed too");
    expect(handoff.mentions).toEqual([{ kind: "bot", botId: s.cat.id }]);
    expect(s.router.mentionOptions).toEqual({ spaced: true });
    expect(setup("owner-v1").router.mentionOptions).toEqual({});
  });
});
