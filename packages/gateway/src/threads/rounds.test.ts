// T1: ADR-0005 amendment 4 — parallel @everyone and durable request rounds, at the router with
// the stores it writes. Deterministic: runs are moved through their states by hand, as the
// lifecycle would, with no sidecar and no model.

import type { BotId, GroupRouting, MessageId, ThreadId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { openDatabase } from "../db/open.js";
import { EventStore } from "../ledger/events.js";
import { type RunRecord, RunStore } from "../ledger/runs.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { MessageStore } from "./messages.js";
import { cancelRound } from "./round-cancel.js";
import { RoundStore } from "./rounds.js";
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
  const walks = new RoutingWalkStore(db);
  const rounds = new RoundStore(db);
  const router = new ThreadRouter(
    threads,
    messages,
    runs,
    () => ({ groupRouting }),
    walks,
    new EventStore(db),
    () => {},
    () => {},
    { groupRouting, rounds },
  );
  const ws = workspaces.create({ name: "w", sandboxProvider: "docker" });
  const [ann, ben, cat, dan] = ["ann", "ben", "cat", "dan"].map((name) =>
    bots.create({ name, role: name, workspaceId: ws.id }),
  ) as [
    ReturnType<BotStore["create"]>,
    ReturnType<BotStore["create"]>,
    ReturnType<BotStore["create"]>,
    ReturnType<BotStore["create"]>,
  ];
  const thread = threads.create({
    workspaceId: ws.id,
    botIds: [ann.id, ben.id, cat.id, dan.id],
  });
  const start = (run: RunRecord): RunRecord =>
    runs.transition(run.id, "running", { deliveredSeq: messages.maxSeq(run.threadId as ThreadId) });
  const end = (run: RunRecord, status: "succeeded" | "silent" | "failed" | "cancelled") => {
    const current = runs.mustGet(run.id);
    const done = runs.transition(run.id, status);
    if (status === "succeeded" || status === "silent")
      threads.advanceLastSeen(done.threadId as ThreadId, done.botId, current.deliveredSeq ?? 0);
    return router.runEnded(done);
  };
  const runOf = (list: readonly RunRecord[], botId: BotId) => {
    const run = list.find((r) => r.botId === botId);
    if (!run) throw new Error(`no run for ${botId}`);
    return run;
  };
  const stateOf = (messageId: MessageId) =>
    Object.fromEntries(
      (rounds.get(messageId)?.members ?? []).map((m) => [bots.mustGet(m.botId).name, m.state]),
    );
  const cancel = (messageId: MessageId) =>
    cancelRound(
      {
        rounds,
        runs,
        walks,
        cancelRun: (id) => runs.transition(id, "cancelled", { error: "round cancelled" }),
      },
      messageId,
      "user:op",
    );
  return {
    db,
    threads,
    messages,
    runs,
    walks,
    rounds,
    router,
    ws,
    ann,
    ben,
    cat,
    dan,
    thread,
    start,
    end,
    runOf,
    stateOf,
    cancel,
  };
}

describe("@everyone consults every member at once (decision 28)", () => {
  it("a human @everyone starts four runs immediately and records one parallel round", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@everyone price check" });
    expect(posted.runs.map((r) => r.botId)).toEqual([s.ann.id, s.ben.id, s.cat.id, s.dan.id]);
    const round = s.rounds.get(posted.message.id);
    expect(round).toMatchObject({ mode: "parallel", total: 4, completed: 0, authorKind: "human" });
    expect(round?.members.map((m) => m.state)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(s.walks.get(posted.message.id)).toBeUndefined();
  });

  it("slow, silent, failed and successful members are independent and attributed", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@everyone status" });
    const [a, b, c, d] = posted.runs.map((r) => s.start(r)) as [
      RunRecord,
      RunRecord,
      RunRecord,
      RunRecord,
    ];
    // dan finishes first although ann, earlier in join order, is still running.
    s.router.postFromRun(d, "all good");
    expect(s.end(d, "succeeded")).toEqual([]);
    s.end(b, "silent");
    s.end(c, "failed");
    expect(s.stateOf(posted.message.id)).toEqual({
      ann: "running",
      ben: "silent",
      cat: "failed",
      dan: "replied",
    });
    const round = s.rounds.get(posted.message.id);
    expect(round).toMatchObject({ completed: 3, total: 4 });
    expect(round?.members.find((m) => m.botId === s.dan.id)?.outputMessageIds).toHaveLength(1);
    expect(a.status).toBe("running");
  });

  it("a bot's @everyone excludes its author and starts the others while it still runs", () => {
    const s = setup();
    const asked = s.router.postHuman({ threadId: s.thread.id, body: "@ann coordinate" });
    const parent = s.start(s.runOf(asked.runs, s.ann.id));
    const broadcast = s.router.postFromRun(parent, "@everyone who has the login?");
    const children = s.runs
      .list({ threadId: s.thread.id })
      .filter((r) => r.triggerRef === broadcast.id);
    expect(children.map((r) => r.botId).sort()).toEqual([s.ben.id, s.cat.id, s.dan.id].sort());
    expect(children.every((r) => r.status === "queued")).toBe(true);
    const round = s.rounds.get(broadcast.id);
    expect(round).toMatchObject({ mode: "parallel", authorKind: "bot", total: 3 });
    expect(round?.parentMessageId).toBe(asked.message.id);
    expect(s.runs.mustGet(parent.id).status).toBe("running");
  });

  it("nested broadcasts cannot deadlock: a child round completes while its parent is open", () => {
    const s = setup();
    const top = s.router.postHuman({ threadId: s.thread.id, body: "@everyone plan" });
    const ann = s.start(s.runOf(top.runs, s.ann.id));
    const nested = s.router.postFromRun(ann, "@everyone need your numbers");
    // ann's own lane is busy, but the child round never waits for ann.
    const childRuns = s.runs
      .list({ threadId: s.thread.id })
      .filter((r) => r.triggerRef === nested.id);
    // ben, cat and dan already have queued wakes from the top round: coalesced, not duplicated.
    expect(childRuns).toEqual([]);
    for (const botId of [s.ben.id, s.cat.id, s.dan.id]) {
      const run = s.start(s.runOf(top.runs, botId));
      s.router.postFromRun(run, "numbers");
      s.end(run, "succeeded");
    }
    expect(s.rounds.get(nested.id)).toMatchObject({ completed: 3, total: 3 });
    expect(s.rounds.get(nested.id)?.parentMessageId).toBe(top.message.id);
    expect(s.rounds.get(top.message.id)).toMatchObject({ completed: 3, total: 4 });
  });

  it("an approval-parked member holds no other round", () => {
    const s = setup();
    const first = s.router.postHuman({ threadId: s.thread.id, body: "@everyone book it" });
    const ann = s.start(s.runOf(first.runs, s.ann.id));
    s.runs.transition(ann.id, "waiting_approval");
    expect(s.stateOf(first.message.id).ann).toBe("awaiting_approval");
    const second = s.router.postHuman({ threadId: s.thread.id, body: "@everyone unrelated" });
    // ann's parked run does not hold its lane: the new round has its own run for ann.
    const annSecond = s.rounds.get(second.message.id)?.members.find((m) => m.botId === s.ann.id);
    expect(annSecond?.runs).toEqual([{ runId: expect.any(String), relation: "created" }]);
    expect(annSecond?.runId).not.toBe(ann.id);
  });

  it("unaddressed messages keep the owner-v1 offer and explicit mentions stay direct", () => {
    const s = setup();
    const open = s.router.postHuman({ threadId: s.thread.id, body: "anyone?" });
    expect(open.runs).toHaveLength(1);
    expect(s.walks.mustGet(open.message.id).mode).toBe("first_taker");
    expect(s.rounds.get(open.message.id)?.mode).toBe("offer");
    s.end(s.start(s.runOf(open.runs, s.ann.id)), "silent");
    const direct = s.router.postHuman({ threadId: s.thread.id, body: "@ben and @cat look" });
    // ben is being offered the earlier request: its queued wake answers both, recorded as such.
    expect(direct.runs.map((r) => r.botId)).toEqual([s.cat.id]);
    const round = s.rounds.get(direct.message.id);
    expect(round).toMatchObject({ mode: "parallel", total: 2 });
    expect(round?.members[0]?.runs[0]?.relation).toBe("coalesced");
  });

  it("a bot's explicit mention is a hop, not a new round", () => {
    const s = setup();
    const asked = s.router.postHuman({ threadId: s.thread.id, body: "@ann go" });
    const ann = s.start(s.runOf(asked.runs, s.ann.id));
    const hop = s.router.postFromRun(ann, "@ben check");
    expect(s.rounds.get(hop.id)).toBeUndefined();
  });
});

describe("sequential discussion is explicit and per message (decision 29)", () => {
  it("walks the members one by one in join order, each after the last ends", () => {
    const s = setup();
    const posted = s.router.postHuman({
      threadId: s.thread.id,
      body: "@everyone discuss",
      roundMode: "sequential",
    });
    expect(posted.runs.map((r) => r.botId)).toEqual([s.ann.id]);
    expect(s.rounds.get(posted.message.id)?.mode).toBe("sequential");
    expect(s.stateOf(posted.message.id)).toEqual({
      ann: "queued",
      ben: "pending",
      cat: "pending",
      dan: "pending",
    });
    const next = s.end(s.start(s.runOf(posted.runs, s.ann.id)), "silent");
    expect(next.map((r) => r.botId)).toEqual([s.ben.id]);
    // The next message is parallel again: the mode belonged to that one message.
    const later = s.router.postHuman({ threadId: s.thread.id, body: "@everyone next" });
    expect(s.rounds.get(later.message.id)?.mode).toBe("parallel");
  });

  it("without @everyone the requested mode changes nothing", () => {
    const s = setup();
    const posted = s.router.postHuman({
      threadId: s.thread.id,
      body: "@ben only",
      roundMode: "sequential",
    });
    expect(s.rounds.get(posted.message.id)?.mode).toBe("parallel");
  });
});

describe("rounds are durable and keyed by message (decisions 30, 31)", () => {
  it("a redelivery adds no round; the same text twice is two rounds", () => {
    const s = setup();
    const first = s.router.postHuman({
      threadId: s.thread.id,
      body: "@everyone same",
      externalId: "ext-1",
    });
    const again = s.router.postHuman({
      threadId: s.thread.id,
      body: "@everyone same",
      externalId: "ext-1",
    });
    expect(again.duplicate).toBe(true);
    expect(s.rounds.list(s.thread.id)).toHaveLength(1);
    s.router.postHuman({ threadId: s.thread.id, body: "@everyone same", externalId: "ext-2" });
    const listed = s.rounds.list(s.thread.id);
    expect(listed).toHaveLength(2);
    expect(listed.map((r) => r.messageId)).not.toContain(undefined);
    expect(listed[1]?.messageId).toBe(first.message.id);
  });

  it("coalescing into a queued wake is an explicit relation; both rounds keep their question", () => {
    const s = setup();
    const first = s.router.postHuman({ threadId: s.thread.id, body: "@everyone q1" });
    const second = s.router.postHuman({ threadId: s.thread.id, body: "@everyone q2" });
    expect(second.runs).toEqual([]);
    const annFirst = s.rounds.get(first.message.id)?.members[0];
    const annSecond = s.rounds.get(second.message.id)?.members[0];
    expect(annFirst?.runs).toEqual([{ runId: annFirst?.runId, relation: "created" }]);
    expect(annSecond?.runs).toEqual([{ runId: annFirst?.runId, relation: "coalesced" }]);
    const run = s.start(s.runOf(first.runs, s.ann.id));
    s.router.postFromRun(run, "answers to both");
    s.end(run, "succeeded");
    expect(s.stateOf(first.message.id).ann).toBe("replied");
    expect(s.stateOf(second.message.id).ann).toBe("replied");
  });

  it("an earlier failure never becomes a later round's state (decision 33)", () => {
    const s = setup();
    const first = s.router.postHuman({ threadId: s.thread.id, body: "@everyone one" });
    s.end(s.start(s.runOf(first.runs, s.cat.id)), "failed");
    const second = s.router.postHuman({ threadId: s.thread.id, body: "@everyone two" });
    expect(s.stateOf(first.message.id).cat).toBe("failed");
    expect(s.stateOf(second.message.id).cat).toBe("queued");
  });

  it("a removed member shows as removed", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@everyone go" });
    s.end(s.start(s.runOf(posted.runs, s.dan.id)), "silent");
    s.threads.removeMember(s.thread.id, s.dan.id);
    expect(s.stateOf(posted.message.id).dan).toBe("removed");
  });
});

describe("cancel targets one round and its descendants (decision 34)", () => {
  it("cancels the round's and its child round's runs, and leaves an overlapping round alone", () => {
    const s = setup();
    const target = s.router.postHuman({ threadId: s.thread.id, body: "@ann @ben task A" });
    const other = s.router.postHuman({ threadId: s.thread.id, body: "@cat task B" });
    const ann = s.start(s.runOf(target.runs, s.ann.id));
    const child = s.router.postFromRun(ann, "@everyone help with A");
    const childRuns = s.runs
      .list({ threadId: s.thread.id })
      .filter((r) => r.triggerRef === child.id);
    // ben coalesced into its queued wake; cat coalesced into task B's queued wake (shared); dan new.
    expect(childRuns.map((r) => r.botId)).toEqual([s.dan.id]);
    const result = s.cancel(target.message.id);
    expect(result.rounds.sort()).toEqual([target.message.id, child.id].sort());
    expect(s.runs.mustGet(ann.id).status).toBe("cancelled");
    expect(s.runs.mustGet(s.runOf(target.runs, s.ben.id).id).status).toBe("cancelled");
    expect(s.runs.mustGet(s.runOf(childRuns, s.dan.id).id).status).toBe("cancelled");
    const cat = s.runOf(other.runs, s.cat.id);
    expect(s.runs.mustGet(cat.id).status).toBe("queued");
    expect(result.kept).toEqual([cat.id]);
    expect(s.rounds.get(other.message.id)?.cancelledAt).toBeUndefined();
    // Nothing later revives the cancelled round.
    expect(s.rounds.relate(target.message.id, s.ann.id, cat.id, "coalesced")).toBe(false);
    expect(() => s.router.retryRoundMember(target.message.id, s.ann.id)).toThrow(/cancelled/);
  });

  it("completes a cancelled sequential round's walk so no later member is woken", () => {
    const s = setup();
    const posted = s.router.postHuman({
      threadId: s.thread.id,
      body: "@everyone debate",
      roundMode: "sequential",
    });
    s.cancel(posted.message.id);
    expect(s.walks.mustGet(posted.message.id).status).toBe("complete");
    expect(s.router.continueWalks()).toEqual([]);
    expect(s.stateOf(posted.message.id)).toMatchObject({ ann: "cancelled", ben: "cancelled" });
  });
});

describe("retry is per member and idempotent (decision 35)", () => {
  it("retries a failed member once and returns the live retry on a second call", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@everyone go" });
    const failed = s.start(s.runOf(posted.runs, s.cat.id));
    s.end(failed, "failed");
    s.end(s.start(s.runOf(posted.runs, s.ben.id)), "silent");
    expect(() => s.router.retryRoundMember(posted.message.id, s.ben.id)).toThrow(
      /failed or stopped/,
    );
    // A live member is not retried: its run is returned as it is.
    expect(s.router.retryRoundMember(posted.message.id, s.ann.id).created).toBe(false);
    const first = s.router.retryRoundMember(posted.message.id, s.cat.id);
    expect(first.created).toBe(true);
    expect(first.run.triggerRef).toBe(posted.message.id);
    const second = s.router.retryRoundMember(posted.message.id, s.cat.id);
    expect(second).toEqual({ run: first.run, created: false });
    const cat = s.rounds.get(posted.message.id)?.members.find((m) => m.botId === s.cat.id);
    expect(cat?.runs.map((r) => r.relation)).toEqual(["created", "retry"]);
    expect(cat?.state).toBe("queued");
  });

  it("refuses a removed member", () => {
    const s = setup();
    const posted = s.router.postHuman({ threadId: s.thread.id, body: "@everyone go" });
    s.end(s.start(s.runOf(posted.runs, s.dan.id)), "failed");
    s.threads.removeMember(s.thread.id, s.dan.id);
    expect(() => s.router.retryRoundMember(posted.message.id, s.dan.id)).toThrow(/no longer/);
  });
});
