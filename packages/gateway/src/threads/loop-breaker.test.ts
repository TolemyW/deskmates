// T1: the message caps as workspace settings and the loop breaker behind them (ADR-0005
// amendment 5, decisions 38, 40 and 41). A router wired to the real limit and budget stores.

import type { BotId, ThreadId, ThreadMessage } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { BudgetStore } from "../budget/budget-store.js";
import { openDatabase } from "../db/open.js";
import { EventStore } from "../ledger/events.js";
import { type RunRecord, RunStore } from "../ledger/runs.js";
import { WorkspaceLimitStore } from "../limits/workspace-limits.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
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
  const budget = new BudgetStore(db);
  const limits = new WorkspaceLimitStore(db, budget, () => 80);
  const published: ThreadMessage[] = [];
  const router = new ThreadRouter(
    threads,
    messages,
    runs,
    () => ({}),
    new RoutingWalkStore(db),
    events,
    () => {},
    (message) => published.push(message),
    { limits },
  );
  const ws = workspaces.create({ name: "w", sandboxProvider: "docker" });
  const alice = bots.create({ name: "alice", role: "a", workspaceId: ws.id });
  const bob = bots.create({ name: "bob", role: "b", workspaceId: ws.id });
  const thread = threads.create({ workspaceId: ws.id, botIds: [alice.id, bob.id] });
  /** Relax both caps to `off`, which needs a monetary limit first (decision 39). */
  const allOff = () => {
    budget.setLimits(ws.id, { weeklyLimitUsd: 50 }, "user:admin");
    limits.set(ws.id, { turnBudget: "off", relayCountMax: "off" }, "user:admin");
  };
  return {
    db,
    threads,
    messages,
    runs,
    events,
    router,
    limits,
    budget,
    ws,
    alice,
    bob,
    thread,
    published,
    allOff,
  };
}

type Setup = ReturnType<typeof setup>;

/**
 * Alice and Bob mention each other, one hop per run, until a hop wakes nobody or `max` hops.
 * Returns the number of hops posted and the last run.
 */
function pingPong(s: Setup, threadId: ThreadId, max: number): { hops: number; last: RunRecord } {
  let run = s.router.postHuman({ threadId, body: "@alice start" }).runs[0];
  if (!run) throw new Error("no first run");
  for (let hop = 1; hop <= max; hop += 1) {
    s.runs.transition(run.id, "running");
    const other: BotId = run.botId === s.alice.id ? s.bob.id : s.alice.id;
    const name = other === s.alice.id ? "alice" : "bob";
    s.router.postFromRun(run, `@${name} hop ${hop}`);
    s.runs.transition(run.id, "succeeded");
    const next = s.runs.list({ botId: other }).find((r) => r.status === "queued");
    if (!next) return { hops: hop, last: run };
    run = next;
  }
  return { hops: max, last: run };
}

const breaches = (s: Setup, run: RunRecord) =>
  s.events.list(run.id).filter((event) => event.kind === "cap_breached");

describe("workspace caps (decision 38)", () => {
  it("a workspace turn budget overrides the thread row, and the breach names limit and source", () => {
    const s = setup();
    s.limits.set(s.ws.id, { turnBudget: 3 }, "user:admin");
    const run = s.router.postHuman({ threadId: s.thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    s.router.postFromRun(run, "@bob one");
    s.router.postFromRun(run, "@bob two");
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
    s.router.postFromRun(run, "@bob three");
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
    expect(breaches(s, run).at(-1)?.payload).toMatchObject({
      cap: "turn_budget",
      limit: 3,
      source: "workspace",
    });
    expect(s.published.at(-1)?.body).toContain(
      "turn budget reached (3 bot messages, workspace setting)",
    );
  });

  it("a workspace relay cap stops the chain at its depth", () => {
    const s = setup();
    s.limits.set(s.ws.id, { relayCountMax: 2 }, "user:admin");
    const { hops, last } = pingPong(s, s.thread.id, 20);
    expect(hops).toBe(3);
    expect(breaches(s, last).at(-1)?.payload).toMatchObject({
      cap: "relay_count",
      limit: 2,
      source: "workspace",
    });
    expect(s.router.effectiveCaps(s.thread.id).relayCountMax).toBe(2);
  });

  it("without settings the thread row and the fixed relay cap apply, with their sources", () => {
    const s = setup();
    const { hops, last } = pingPong(s, s.thread.id, 20);
    expect(hops).toBe(6);
    expect(breaches(s, last).at(-1)?.payload).toMatchObject({
      cap: "relay_count",
      limit: 5,
      source: "default",
    });
  });

  it("a change never unpauses a paused thread", () => {
    const s = setup();
    s.limits.set(s.ws.id, { turnBudget: 1 }, "user:admin");
    const run = s.router.postHuman({ threadId: s.thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    s.router.postFromRun(run, "@bob one");
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
    s.limits.set(s.ws.id, { turnBudget: 50 }, "user:admin");
    s.router.postFromRun(run, "@bob two");
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(0);
  });
});

describe("loop breaker (decision 40)", () => {
  it("depth: with both caps off a ping-pong still ends at hop 51", () => {
    const s = setup();
    s.allOff();
    const { hops, last } = pingPong(s, s.thread.id, 200);
    expect(hops).toBe(51);
    expect(breaches(s, last).at(-1)?.payload).toMatchObject({
      cap: "loop_breaker",
      rule: "depth",
      limit: 50,
      source: "loop_breaker",
    });
    expect(s.published.at(-1)?.body).toContain("loop breaker tripped (50 hops)");
  });

  it("depth crosses threads: a run woken at depth 50 posting into a bus thread wakes nobody", () => {
    const s = setup();
    s.allOff();
    const bus = s.threads.create({
      workspaceId: s.ws.id,
      kind: "bus",
      channel: "internal",
      botIds: [s.alice.id, s.bob.id],
    });
    const deep = s.messages.append({
      threadId: s.thread.id,
      authorKind: "bot",
      authorId: s.bob.id,
      body: "@alice deep",
      relayCount: 50,
    });
    const run = s.runs.create({
      botId: s.alice.id,
      threadId: s.thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: deep.id,
      config: {},
    });
    s.runs.transition(run.id, "running");
    const posted = s.router.postFromRunToThread(run, bus.id, "ping", [], s.bob.id);
    expect(posted.relayCount).toBe(51);
    expect(s.runs.list({ botId: s.bob.id })).toHaveLength(0);
    expect(breaches(s, run).at(-1)?.payload).toMatchObject({ cap: "loop_breaker", rule: "depth" });
  });

  it("volume: with the turn budget off the 100th bot message pauses the thread", () => {
    const s = setup();
    s.allOff();
    const run = s.router.postHuman({ threadId: s.thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    for (let i = 1; i < 100; i += 1) s.router.postFromRun(run, `@bob item ${i}`);
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
    s.router.postFromRun(run, "@bob item 100");
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
    expect(breaches(s, run).at(-1)?.payload).toMatchObject({
      cap: "loop_breaker",
      rule: "volume",
      limit: 100,
    });
  });

  it("repetition: a relaxed thread pauses on a bot's third identical message", () => {
    const s = setup();
    s.limits.set(s.ws.id, { turnBudget: 40 }, "user:admin");
    const run = s.router.postHuman({ threadId: s.thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    s.router.postFromRun(run, "@bob Status?");
    s.router.postFromRun(run, "something else");
    s.router.postFromRun(run, "  @bob   status? ");
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
    s.router.postFromRun(run, "@BOB STATUS?");
    expect(s.threads.mustGet(s.thread.id).status).toBe("paused");
    expect(breaches(s, run).at(-1)?.payload).toMatchObject({
      cap: "loop_breaker",
      rule: "repetition",
      limit: 3,
    });
  });

  it("repetition is not armed on the defaults, so decision 6 behaves as before", () => {
    const s = setup();
    const run = s.router.postHuman({ threadId: s.thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    for (let i = 0; i < 3; i += 1) s.router.postFromRun(run, "ok");
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
    expect(breaches(s, run)).toHaveLength(0);
  });

  it("a human message resets the repetition window", () => {
    const s = setup();
    s.limits.set(s.ws.id, { turnBudget: 40 }, "user:admin");
    const run = s.router.postHuman({ threadId: s.thread.id, body: "@alice go" }).runs[0];
    if (!run) throw new Error("no run");
    s.runs.transition(run.id, "running");
    s.router.postFromRun(run, "done");
    s.router.postFromRun(run, "done");
    s.router.postHuman({ threadId: s.thread.id, body: "thanks" });
    s.router.postFromRun(run, "done");
    expect(s.threads.mustGet(s.thread.id).status).toBe("active");
  });
});
