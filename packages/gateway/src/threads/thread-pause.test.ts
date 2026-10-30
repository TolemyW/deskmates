// T1: a thread pause has a reason, a notice and an operator switch, and a turn-budget pause ends
// by itself after the workspace's reset window (ADR-0005 amendment 3: decisions 20, 23 to 25 and
// 27 as accepted, 21, 22 and 26 as rewritten on 2026-10-17). A router wired to the real limit
// store and a fake clock.

import { RUN_ERROR_OPERATOR_PAUSE, RUN_ERROR_TURN_BUDGET } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { BudgetStore } from "../budget/budget-store.js";
import { openDatabase } from "../db/open.js";
import { EventStore } from "../ledger/events.js";
import { type RunRecord, RunStore } from "../ledger/runs.js";
import { WorkspaceLimitStore } from "../limits/workspace-limits.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { buildDelivery } from "./delivery.js";
import { MessageStore } from "./messages.js";
import { ThreadRouter } from "./router.js";
import { RoutingWalkStore } from "./routing-walks.js";
import { ThreadStore } from "./threads.js";

const START = Date.parse("2026-10-17T12:00:00.000Z");
const MINUTE = 60_000;

function setup(turnBudget = 2) {
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceStore(db);
  const bots = new BotStore(db);
  const threads = new ThreadStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const events = new EventStore(db);
  const limits = new WorkspaceLimitStore(db, new BudgetStore(db), () => 80);
  const clock = { now: START };
  const changed: string[] = [];
  const router = new ThreadRouter(
    threads,
    messages,
    runs,
    () => ({}),
    new RoutingWalkStore(db),
    events,
    () => {},
    () => {},
    {
      limits,
      now: () => new Date(clock.now),
      onThreadChanged: (threadId) => changed.push(threadId),
    },
  );
  const ws = workspaces.create({ name: "w", sandboxProvider: "docker" });
  const alice = bots.create({ name: "alice", role: "a", workspaceId: ws.id });
  const bob = bots.create({ name: "bob", role: "b", workspaceId: ws.id });
  const carol = bots.create({ name: "carol", role: "c", workspaceId: ws.id });
  const thread = threads.create({
    workspaceId: ws.id,
    botIds: [alice.id, bob.id, carol.id],
  });
  limits.set(ws.id, { turnBudget }, "user:admin");
  const system = () => messages.list(thread.id).filter((m) => m.authorKind === "system");
  /** A run of `bot` in the thread, running, as a wake would have left it. */
  const running = (botId: RunRecord["botId"]) => {
    const human = router.postHuman({ threadId: thread.id, body: "@alice go" });
    const run =
      human.runs.find((r) => r.botId === botId) ??
      runs.create({
        botId,
        threadId: thread.id,
        lane: "interactive",
        triggerKind: "thread_message",
        triggerRef: human.message.id,
      });
    return runs.transition(run.id, "running");
  };
  /** Post bot messages from `run` until the thread pauses; returns how many were posted. */
  const breach = (run: RunRecord) => {
    let posted = 0;
    while (threads.mustGet(thread.id).status === "active" && posted < 20) {
      router.postFromRun(run, `@bob step ${posted}`);
      posted += 1;
    }
    return posted;
  };
  return {
    db,
    threads,
    messages,
    runs,
    events,
    limits,
    router,
    clock,
    changed,
    ws,
    alice,
    bob,
    carol,
    thread,
    system,
    running,
    breach,
  };
}

describe("decision 20: a pause records its reason", () => {
  it("writes status, reason, causing seq, pause time and resume time on a breach", () => {
    const s = setup();
    expect(s.threads.mustGet(s.thread.id)).not.toHaveProperty("pauseReason");
    const run = s.running(s.alice.id);
    s.breach(run);
    const last = s.messages
      .list(s.thread.id)
      .filter((m) => m.authorKind === "bot")
      .at(-1);
    expect(s.threads.mustGet(s.thread.id)).toMatchObject({
      status: "paused",
      pauseReason: "turn_budget",
      pausedSeq: last?.seq,
      pausedAt: new Date(START).toISOString(),
      resumeAt: new Date(START + 60 * MINUTE).toISOString(),
    });
  });

  it("refuses a paused row without a reason and a resume time on an operator pause", () => {
    const s = setup();
    expect(() =>
      s.db.prepare("UPDATE threads SET status = 'paused' WHERE id = ?").run(s.thread.id),
    ).toThrow(/CHECK/);
    expect(() =>
      s.threads.pause(s.thread.id, {
        reason: "operator",
        seq: 0,
        at: new Date(START).toISOString(),
        resumeAt: new Date(START).toISOString(),
      }),
    ).toThrow(/no resume time/);
  });
});

describe("rewritten decision 21: one notice per pause, with the resume time", () => {
  it("names the dropped mention, the cancelled runs and when the thread resumes", () => {
    const s = setup();
    const run = s.running(s.alice.id);
    // Carol has a queued wake that the breach cancels.
    const queued = s.router.postHuman({ threadId: s.thread.id, body: "@carol later" }).runs[0];
    const before = s.system().length;
    s.breach(run);
    const notices = s.system().slice(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toMatch(/^turn budget reached \(2 bot messages, workspace setting\)/);
    expect(notices[0]?.body).toContain("alice's mention of bob was not delivered");
    expect(notices[0]?.body).toContain("queued runs cancelled for");
    expect(notices[0]?.body).toContain(
      `It resumes by itself at ${new Date(START + 60 * MINUTE).toISOString()} (in 60 minutes)`,
    );
    expect(s.runs.mustGet(queued?.id as RunRecord["id"])).toMatchObject({
      status: "cancelled",
      error: RUN_ERROR_TURN_BUDGET,
    });
    // The notice wakes nobody and counts toward neither cap.
    expect(s.runs.list({ threadId: s.thread.id }).filter((r) => r.status === "queued")).toEqual([]);
    expect(notices[0]?.relayCount).toBe(0);
    expect(s.messages.botCountSinceOrigin(s.thread.id)).toBe(2);
  });

  it("posts no second notice for bot messages while the thread is already paused", () => {
    const s = setup();
    const run = s.running(s.alice.id);
    s.breach(run);
    const after = s.system().length;
    s.router.postFromRun(run, "@bob still there?");
    s.router.postFromRun(run, "@bob hello?");
    expect(s.system()).toHaveLength(after);
    // The breach is still ledgered.
    expect(s.events.list(run.id).filter((e) => e.kind === "cap_breached").length).toBe(3);
  });
});

describe("rewritten decision 22: the reset window and the budget origin", () => {
  it("resumes by itself once the window has passed, with one notice and the origin reset", () => {
    const s = setup();
    const run = s.running(s.alice.id);
    s.breach(run);
    s.clock.now = START + 59 * MINUTE;
    expect(s.router.resumeDuePauses()).toEqual([]);
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
    s.clock.now = START + 60 * MINUTE;
    const before = s.system().length;
    expect(s.router.resumeDuePauses()).toEqual([s.thread.id]);
    const notices = s.system().slice(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("resumed automatically and its turn budget was reset");
    const thread = s.threads.mustGet(s.thread.id);
    expect(thread).toMatchObject({ status: "active", budgetResetSeq: notices[0]?.seq });
    expect(thread).not.toHaveProperty("pauseReason");
    expect(thread).not.toHaveProperty("resumeAt");
    expect(s.changed).toContain(s.thread.id);
    // A second pass finds nothing: a pause gets one resume notice.
    s.clock.now = START + 120 * MINUTE;
    expect(s.router.resumeDuePauses()).toEqual([]);
    expect(s.system()).toHaveLength(before + 1);
  });

  it("does not breach again on the first reply; breaches after the budget's worth", () => {
    const s = setup(3);
    const run = s.running(s.alice.id);
    s.breach(run);
    s.clock.now = START + 61 * MINUTE;
    s.router.resumeDuePauses();
    const next = s.runs.transition(
      s.runs.create({
        botId: s.bob.id,
        threadId: s.thread.id,
        lane: "interactive",
        triggerKind: "thread_message",
        triggerRef: "after",
      }).id,
      "running",
    );
    const first = s.router.postFromRunRouted(next, "@alice picking it up");
    expect(first.wakeBlocked).toBeUndefined();
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
    s.router.postFromRun(next, "@carol two");
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
    s.router.postFromRun(next, "@carol three");
    expect(s.threads.mustGet(s.thread.id)).toMatchObject({
      status: "paused",
      pauseReason: "turn_budget",
    });
  });

  it("uses the workspace's reset window in effect at the pause", () => {
    const s = setup();
    s.limits.set(s.ws.id, { turnBudgetResetMinutes: 15 }, "user:admin");
    s.breach(s.running(s.alice.id));
    expect(s.threads.mustGet(s.thread.id).resumeAt).toBe(
      new Date(START + 15 * MINUTE).toISOString(),
    );
    // A later change applies to the next pause, so the time in the notice stays true.
    s.limits.set(s.ws.id, { turnBudgetResetMinutes: 120 }, "user:admin");
    s.clock.now = START + 15 * MINUTE;
    expect(s.router.resumeDuePauses()).toEqual([s.thread.id]);
  });

  it("a human message moves the origin past an earlier reset", () => {
    const s = setup();
    s.breach(s.running(s.alice.id));
    s.clock.now = START + 60 * MINUTE;
    s.router.resumeDuePauses();
    const reset = s.threads.mustGet(s.thread.id).budgetResetSeq ?? 0;
    const human = s.router.postHuman({ threadId: s.thread.id, body: "carry on" });
    expect(human.message.seq).toBeGreaterThan(reset);
    expect(s.messages.botCountSinceOrigin(s.thread.id)).toBe(0);
  });

  it("treats a loop-breaker pause as a turn-budget pause and restarts its count", () => {
    const s = setup();
    s.limits.set(s.ws.id, { turnBudget: "off" }, "user:admin");
    const run = s.running(s.alice.id);
    for (let i = 0; i < 3; i += 1) s.router.postFromRun(run, "same thing");
    expect(s.threads.mustGet(s.thread.id)).toMatchObject({
      status: "paused",
      pauseReason: "turn_budget",
      resumeAt: new Date(START + 60 * MINUTE).toISOString(),
    });
    s.clock.now = START + 60 * MINUTE;
    s.router.resumeDuePauses();
    // The repetition rule counts from the new origin: one more identical message does not trip.
    s.router.postFromRun(run, "same thing");
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
  });
});

describe("decision 23 and rewritten 22: operator pause and resume", () => {
  it("pauses with reason operator, cancels queued runs and leaves live and parked runs", () => {
    const s = setup();
    const live = s.running(s.alice.id);
    const parkedRun = s.runs.create({
      botId: s.carol.id,
      threadId: s.thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "p",
    });
    s.runs.transition(parkedRun.id, "running");
    const parked = s.runs.transition(parkedRun.id, "waiting_approval");
    const queued = s.router.postHuman({ threadId: s.thread.id, body: "@bob please" }).runs[0];
    const change = s.router.operatorPause(s.thread.id);
    expect(change.changed).toBe(true);
    expect(change.cancelled.map((r) => r.id)).toEqual([queued?.id]);
    expect(s.runs.mustGet(queued?.id as RunRecord["id"]).error).toBe(RUN_ERROR_OPERATOR_PAUSE);
    expect(s.runs.mustGet(live.id).status).toBe("running");
    expect(s.runs.mustGet(parked.id).status).toBe("waiting_approval");
    expect(s.threads.mustGet(s.thread.id)).toMatchObject({
      status: "paused",
      pauseReason: "operator",
    });
    expect(s.threads.mustGet(s.thread.id)).not.toHaveProperty("resumeAt");
    // Asking again changes nothing.
    expect(s.router.operatorPause(s.thread.id).changed).toBe(false);
  });

  it("takes over a turn-budget pause, which then no longer ends by itself", () => {
    const s = setup();
    s.breach(s.running(s.alice.id));
    s.router.operatorPause(s.thread.id);
    s.clock.now = START + 600 * MINUTE;
    expect(s.router.resumeDuePauses()).toEqual([]);
    expect(s.threads.mustGet(s.thread.id).pauseReason).toBe("operator");
  });

  it.each(["operator", "turn_budget"] as const)(
    "resumes a %s pause with one notice naming the person and a budget reset",
    (kind) => {
      const s = setup();
      const run = s.running(s.alice.id);
      if (kind === "operator") s.router.operatorPause(s.thread.id);
      else s.breach(run);
      const before = s.system().length;
      const change = s.router.operatorResume(s.thread.id, "Ada");
      expect(change.changed).toBe(true);
      expect(
        s
          .system()
          .slice(before)
          .map((m) => m.body),
      ).toEqual(["Resumed by Ada; turn budget reset."]);
      expect(s.threads.mustGet(s.thread.id)).toMatchObject({
        status: "active",
        budgetResetSeq: change.notice?.seq,
      });
      // The first bot reply after it does not breach.
      expect(s.router.postFromRunRouted(run, "@bob next").wakeBlocked).toBeUndefined();
      expect(s.router.operatorResume(s.thread.id, "Ada").changed).toBe(false);
    },
  );
});

describe("decision 24: a human message ends a turn-budget pause, not an operator pause", () => {
  it("stores the message and wakes nobody in an operator-paused thread", () => {
    const s = setup();
    s.router.operatorPause(s.thread.id);
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@bob are you there" });
    expect(posted).toMatchObject({ runs: [], paused: "operator" });
    expect(s.messages.get(posted.message.id)?.body).toBe("@bob are you there");
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
  });

  it("a system notice in an operator-paused thread is stored and wakes nobody (#61 L5)", () => {
    const s = setup();
    s.router.operatorPause(s.thread.id);
    const posted = s.router.postSystem(s.thread.id, "bob exhausted its turn budget", [], {
      wakeOnly: s.bob.id,
    });
    expect(posted.runs).toEqual([]);
    expect(s.messages.get(posted.message.id)?.body).toBe("bob exhausted its turn budget");
    expect(s.runs.findQueued(s.bob.id, s.thread.id)).toBeUndefined();
  });

  it("unpauses a turn-budget pause and wakes as usual", () => {
    const s = setup();
    s.breach(s.running(s.alice.id));
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@carol take over" });
    expect(posted.runs.map((r) => r.botId)).toEqual([s.carol.id]);
    expect(s.threads.mustGet(s.thread.id)).toMatchObject({ status: "active" });
    expect(s.threads.mustGet(s.thread.id)).not.toHaveProperty("pauseReason");
  });
});

describe("decision 25: resuming never resurrects cancelled work", () => {
  it.each(["human", "operator", "window"] as const)(
    "leaves cancelled runs cancelled after a %s resume",
    (how) => {
      const s = setup();
      const run = s.running(s.alice.id);
      const queued = s.router.postHuman({ threadId: s.thread.id, body: "@carol later" }).runs[0];
      s.breach(run);
      const cancelled = s.runs
        .list({ threadId: s.thread.id })
        .filter((r) => r.status === "cancelled");
      expect(cancelled.length).toBeGreaterThan(0);
      if (how === "human") s.router.postHuman({ threadId: s.thread.id, body: "ok" });
      if (how === "operator") s.router.operatorResume(s.thread.id, "Ada");
      if (how === "window") {
        s.clock.now = START + 60 * MINUTE;
        s.router.resumeDuePauses();
      }
      s.router.continueWalks();
      expect(s.runs.mustGet(queued?.id as RunRecord["id"]).status).toBe("cancelled");
      // No run is created again for the messages whose wakes the pause cancelled.
      const live = s.runs.list({ threadId: s.thread.id }).filter((r) => r.status !== "cancelled");
      for (const old of cancelled)
        expect(live.some((r) => r.botId === old.botId && r.triggerRef === old.triggerRef)).toBe(
          false,
        );
    },
  );
});

describe("rewritten decision 26: what unpauses a thread", () => {
  it("bot messages and scheduler passes before the window leave a turn-budget pause paused", () => {
    const s = setup();
    const run = s.running(s.alice.id);
    s.breach(run);
    for (let i = 0; i < 5; i += 1) s.router.postFromRun(run, `@bob ${i}`);
    s.clock.now = START + 30 * MINUTE;
    s.router.continueWalks();
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
    // The scheduler's pass is the clock: past the window, the same entry point resumes it.
    s.clock.now = START + 60 * MINUTE;
    s.router.continueWalks();
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
  });

  it("nothing but Resume ends an operator pause", () => {
    const s = setup();
    const run = s.running(s.alice.id);
    s.router.operatorPause(s.thread.id);
    s.router.postHuman({ threadId: s.thread.id, body: "hello" });
    s.router.postFromRun(run, "@bob hi");
    s.clock.now = START + 10_000 * MINUTE;
    s.router.continueWalks();
    s.router.postSystem(s.thread.id, "an approval reminder", [], { inert: true });
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
  });
});

describe("decision 27: a run is told the thread is paused", () => {
  it("carries the pause in the routing context of a delivery", () => {
    const s = setup();
    s.breach(s.running(s.alice.id));
    const thread = s.threads.mustGet(s.thread.id);
    const delivery = buildDelivery(
      thread,
      s.bob.id,
      s.messages.list(s.thread.id),
      new Map(),
      16000,
    );
    expect(delivery.trigger.routing?.paused).toEqual({
      reason: "turn_budget",
      resumeAt: thread.resumeAt,
    });
    s.router.operatorPause(s.thread.id);
    const operator = buildDelivery(
      s.threads.mustGet(s.thread.id),
      s.bob.id,
      s.messages.list(s.thread.id),
      new Map(),
      16000,
    );
    expect(operator.trigger.routing?.paused).toEqual({ reason: "operator" });
    s.router.operatorResume(s.thread.id, "Ada");
    const active = buildDelivery(s.threads.mustGet(s.thread.id), s.bob.id, [], new Map(), 16000);
    expect(active.trigger.routing).not.toHaveProperty("paused");
  });
});
