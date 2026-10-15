// T1: actual Gateway HTTP/lifecycle with an in-process provider; no model or Docker.
import { type StartRunRequest, isTerminal } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "./events/bus.js";
import { type Harness, startHarness, waitFor } from "./test-support/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
const summary = (reply: string) => ({
  done: "handled",
  reply,
  filesChanged: [],
  sitesVisited: [],
  pendingApprovals: [],
  memorySuggestions: [],
});

async function group(turnBudget?: number, overrides: Parameters<typeof startHarness>[0] = {}) {
  const h = await startHarness(overrides);
  harnesses.push(h);
  const ctx = h.app.deskmates.ctx;
  const ws = ctx.workspaces.create({ name: "group", sandboxProvider: "docker" });
  const bots = ["chief", "alice", "bob"].map((name) =>
    ctx.bots.create({ name, role: name, workspaceId: ws.id }),
  );
  const thread = ctx.threads.create({
    workspaceId: ws.id,
    botIds: bots.map((b) => b.id),
    ...(turnBudget === undefined ? {} : { turnBudget }),
  });
  // The turn budget is off by default (ADR-0005 amendment 5 decision 42); a fixture that wants one
  // turns it on for the workspace, which is what the router enforces.
  if (turnBudget !== undefined) ctx.limits.set(ws.id, { turnBudget }, "user:admin");
  return { h, ctx, bots, thread };
}

describe("M2 group foundation through the Gateway", () => {
  it("deduplicates a final reply against its own successful post without routing or spending budget again", async () => {
    const { h, ctx, thread } = await group();
    h.app.deskmates.scheduler.stop();
    const run = ctx.router.postHuman({ threadId: thread.id, body: "@chief review" }).runs[0];
    if (!run) throw new Error("missing run");
    const started = h.app.deskmates.lifecycle.start(run).run;
    // Start records the pinned-index receipt; the rolled-back end must add nothing after it.
    const startEvents = ctx.events.list(run.id);
    expect(startEvents.map((e) => [e.seq, e.kind])).toEqual([[1, "memory_index"]]);
    const posted = ctx.router.postFromRun(started, "@alice result");
    const runsBefore = ctx.runs.list({ threadId: thread.id }).length;
    const route = vi.spyOn(ctx.router, "postFromRun");
    const events: GatewayEvent[] = [];
    ctx.bus.subscribe((event) => events.push(event));
    const ended = {
      type: "run_ended" as const,
      runId: run.id,
      outcome: "completed" as const,
      usage: [],
      summary: summary("  @alice result  "),
    };
    const fault = vi.spyOn(ctx.threads, "advanceLastSeen").mockImplementationOnce(() => {
      throw new Error("dedup rollback");
    });
    expect(() => h.app.deskmates.lifecycle.ended(run.id, ended)).toThrow("dedup rollback");
    fault.mockRestore();
    expect(events).toEqual([]);
    expect(ctx.events.list(run.id)).toEqual(startEvents);
    h.app.deskmates.lifecycle.ended(run.id, ended);
    expect(route).not.toHaveBeenCalled();
    expect(ctx.messages.list(thread.id)).toHaveLength(2);
    expect(ctx.messages.botCountSinceLastHuman(thread.id)).toBe(1);
    expect(ctx.runs.list({ threadId: thread.id })).toHaveLength(runsBefore);
    expect(ctx.runs.mustGet(run.id).status).toBe("succeeded");
    expect(events.filter((e) => e.type === "thread_message")).toEqual([]);
    expect(ctx.events.list(run.id)).toEqual([
      ...startEvents,
      expect.objectContaining({
        payload: { source: "final_reply", op: "deduplicated", messageId: posted.id },
      }),
      // ADR-0037: recorded only after the end committed, so the rolled-back try left none.
      expect.objectContaining({
        payload: expect.objectContaining({ source: "run_timeline", mark: "run_ended" }),
      }),
    ]);
    route.mockRestore();
  });

  it.each(["different body", "different run", "different thread"])(
    "preserves a final reply with %s",
    async (difference) => {
      const { h, ctx, bots, thread } = await group();
      h.app.deskmates.scheduler.stop();
      const prior = ctx.router.postHuman({ threadId: thread.id, body: "@chief first" }).runs[0];
      if (!prior) throw new Error("missing run");
      let started = h.app.deskmates.lifecycle.start(prior).run;
      if (difference === "different run") {
        ctx.router.postFromRun(started, "result");
        h.app.deskmates.lifecycle.ended(prior.id, {
          type: "run_ended",
          runId: prior.id,
          outcome: "completed",
          usage: [],
          summary: summary(""),
        });
        const next = ctx.router.postHuman({ threadId: thread.id, body: "@chief next" }).runs[0];
        if (!next) throw new Error("missing next run");
        started = h.app.deskmates.lifecycle.start(next).run;
      } else if (difference === "different thread") {
        const other = ctx.threads.create({
          workspaceId: thread.workspaceId,
          botIds: bots.map((b) => b.id),
        });
        const target = bots[1];
        if (!target) throw new Error("missing peer");
        ctx.router.postFromRunToThread(started, other.id, "result", [], target.id);
      } else ctx.router.postFromRun(started, "progress");
      const before = ctx.messages.list(thread.id).length;
      h.app.deskmates.lifecycle.ended(started.id, {
        type: "run_ended",
        runId: started.id,
        outcome: "completed",
        usage: [],
        summary: summary("result"),
      });
      expect(ctx.messages.list(thread.id)).toHaveLength(before + 1);
      expect(ctx.messages.list(thread.id).at(-1)).toMatchObject({
        body: "result",
        runId: started.id,
      });
    },
  );

  it("rolls back a failed final reply without publishing its recipient wake", async () => {
    const { h, ctx, thread } = await group();
    h.app.deskmates.scheduler.stop();
    const posted = ctx.router.postHuman({ threadId: thread.id, body: "@chief review" });
    const run = posted.runs[0];
    if (!run) throw new Error("missing chief run");
    h.app.deskmates.lifecycle.start(run);
    const events: GatewayEvent[] = [];
    ctx.bus.subscribe((event) => events.push(event));
    const fault = vi.spyOn(ctx.threads, "advanceLastSeen").mockImplementationOnce(() => {
      throw new Error("injected failure after final reply");
    });
    expect(() =>
      h.app.deskmates.lifecycle.ended(run.id, {
        type: "run_ended",
        runId: run.id,
        outcome: "completed",
        usage: [],
        summary: summary("@alice please review"),
      }),
    ).toThrow("injected");
    fault.mockRestore();
    expect(events).toEqual([]);
    expect(ctx.messages.list(thread.id)).toHaveLength(1);
    expect(ctx.runs.list({ threadId: thread.id })).toHaveLength(1);
    expect(ctx.runs.mustGet(run.id).status).toBe("running");
  });

  it("under walk-v1, walks an unaddressed message once per member and does not wake a bot for a reply it already saw", async () => {
    const { h, ctx, thread } = await group(undefined, { groupRouting: "walk-v1" });
    const seen: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      seen.push(req);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(req.botName === "chief" ? "Owner response" : ""),
      });
    });
    expect(
      (await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "Please review" })).status,
    ).toBe(201);
    await waitFor(
      () =>
        seen.length >= 3 &&
        ctx.runs.list({ threadId: thread.id }).every((r) => isTerminal(r.status)),
    );
    await h.app.deskmates.scheduler.drain();
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
    expect(seen.map((r) => r.botName)).toEqual(["chief", "alice", "bob"]);
    expect(
      ctx.runs
        .list({ threadId: thread.id })
        .map((r) => r.status)
        .sort(),
    ).toEqual(["silent", "silent", "succeeded"]);
    for (const req of seen.slice(1)) {
      expect(req.trigger.kind).toBe("thread_message");
      if (req.trigger.kind === "thread_message") {
        expect(req.trigger.messages.some((m) => m.body === "Owner response")).toBe(true);
      }
    }
  });

  it("starts explicitly mentioned peers together and retains per-message run attribution", async () => {
    const { h, ctx, thread } = await group();
    const started: string[] = [];
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.provider.onRun(async (req, gw) => {
      started.push(req.botName);
      expect(req.trigger.kind).toBe("thread_message");
      if (req.trigger.kind === "thread_message") {
        expect(req.trigger.routing).toEqual({
          version: 1,
          recipientBotId: req.botId,
          recipientName: req.botName,
          sourceMessageSeq: 1,
        });
        expect(req.trigger.messages[0]?.addressing).toBe("recipient");
      }
      expect(ctx.runs.mustGet(req.runId).config.threadContextVersion).toBe(1);
      if (started.length === 2) release();
      await barrier;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(""),
      });
    });
    try {
      const posted = await h.api<{ message: { id: string } }>(
        "POST",
        `/api/threads/${thread.id}/messages`,
        { body: "@alice @bob check this" },
      );
      expect(posted.status).toBe(201);
      await waitFor(() => started.length === 2, 3000, "two concurrent peer runs");
      await h.app.deskmates.scheduler.drain();
      const runs = ctx.runs.list({ threadId: thread.id });
      expect(started.sort()).toEqual(["alice", "bob"]);
      expect(runs).toHaveLength(2);
      expect(
        runs.every((r) => r.triggerRef === posted.json.message.id && r.lane === "interactive"),
      ).toBe(true);
    } finally {
      release();
    }
  });

  it("caps an explicit bot ping-pong and a fresh human message starts a new chain", async () => {
    const { h, ctx, thread } = await group();
    // Always reply to the other peer. This deliberately adversarial behavior is a
    // framework test of caps, not a production prompt strategy. Each reply differs, so the relay
    // cap ends the chain rather than the repetition rule (ADR-0005 amendment 5 decision 40).
    let hop = 0;
    h.provider.onRun(async (req, gw) => {
      hop += 1;
      const reply = req.botName === "chief" ? `@alice next ${hop}` : `@chief next ${hop}`;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(reply),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "@chief start" });
    await waitFor(
      () =>
        ctx.runs.list({ threadId: thread.id }).length >= 6 &&
        ctx.runs.list({ threadId: thread.id }).every((r) => isTerminal(r.status)),
    );
    await h.app.deskmates.scheduler.drain();
    expect(ctx.runs.list({ threadId: thread.id }).length).toBeLessThanOrEqual(6);
    expect(
      ctx.messages.list(thread.id).some((m) => m.authorKind === "system" && m.body.includes("cap")),
    ).toBe(true);
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(""),
      });
    });
    const before = ctx.runs.list({ threadId: thread.id }).length;
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "@chief start fresh" });
    await waitFor(
      () =>
        ctx.runs.list({ threadId: thread.id }).length > before &&
        ctx.runs.list({ threadId: thread.id }).every((r) => isTerminal(r.status)),
    );
    expect(ctx.threads.mustGet(thread.id).status).toBe("active");
  });

  it("bounds adversarial fan-out and resumes only the fresh human request after a turn-budget pause", async () => {
    // With the default budget of eight, concurrent replies can reach the independent relay cap
    // first and legitimately end the fan-out without pausing. Four guarantees the budget wins.
    const { h, ctx, bots, thread } = await group(4);
    let startedAfterPause = 0;
    ctx.bus.subscribe((event) => {
      if (
        event.type === "run_status" &&
        event.run.threadId === thread.id &&
        event.run.status === "running" &&
        ctx.threads.mustGet(thread.id).status === "paused"
      ) {
        startedAfterPause++;
      }
    });
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(
          bots
            .filter((b) => b.id !== req.botId)
            .map((b) => `@${b.name}`)
            .join(" "),
        ),
      });
    });
    // Sequential keeps this fixture's single-entry chain; the parallel bound is the next case.
    await h.api("POST", `/api/threads/${thread.id}/messages`, {
      body: "@everyone start",
      roundMode: "sequential",
    });
    await waitFor(() => ctx.threads.mustGet(thread.id).status === "paused", 3000, "turn budget");
    await h.app.deskmates.scheduler.drain();
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
    expect(startedAfterPause).toBe(0);
    const before = ctx.runs.list({ threadId: thread.id }).length;
    expect(before).toBeLessThanOrEqual(thread.turnBudget + bots.length + bots.length);
    const fresh: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      fresh.push(req);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(""),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "@chief start fresh" });
    await waitFor(() => fresh.length > 0);
    await h.app.deskmates.scheduler.drain();
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
    expect(fresh.map((r) => r.botName)).toEqual(["chief"]);
    expect(ctx.threads.mustGet(thread.id).status).toBe("active");
  });

  it("bounds adversarial fan-out from a parallel @everyone by the same caps (ADR-0005 amendment 4)", async () => {
    const { h, ctx, bots, thread } = await group(4);
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(
          bots
            .filter((b) => b.id !== req.botId)
            .map((b) => `@${b.name}`)
            .join(" "),
        ),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "@everyone start" });
    await waitFor(() => ctx.threads.mustGet(thread.id).status === "paused", 3000, "turn budget");
    await h.app.deskmates.scheduler.drain();
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
    const runs = ctx.runs.list({ threadId: thread.id });
    expect(runs.length).toBeLessThanOrEqual(thread.turnBudget + bots.length + bots.length);
    expect(runs.every((r) => r.status !== "queued" && r.status !== "running")).toBe(true);
  });
});

describe("ADR-0005 amendment 2 through the Gateway: an unaddressed request gets one owner", () => {
  const settle = async (h: Harness): Promise<void> => {
    await h.app.deskmates.scheduler.drain();
    h.app.deskmates.scheduler.tick();
    await h.app.deskmates.scheduler.drain();
  };

  it("costs one run when the first member answers, and the wake carries roster, offer and norm", async () => {
    const { h, ctx, bots, thread } = await group();
    const seen: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      seen.push(req);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary("Owner response"),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "Please review" });
    await waitFor(
      () =>
        seen.length >= 1 &&
        ctx.runs.list({ threadId: thread.id }).every((r) => isTerminal(r.status)),
    );
    await settle(h);
    expect(seen.map((r) => r.botName)).toEqual(["chief"]);
    const [req] = seen;
    expect(req?.groupGuidance).toBe("owner-v1");
    expect(req?.trigger).toMatchObject({
      kind: "thread_message",
      routing: {
        version: 2,
        members: [
          { name: "chief", role: "chief", you: true },
          { name: "alice", role: "alice" },
          { name: "bob", role: "bob" },
        ],
        offer: { messageSeq: 1, passed: [], remaining: ["alice", "bob"] },
      },
    });
    const [run] = ctx.runs.list({ threadId: thread.id });
    expect(run?.config).toMatchObject({
      groupRouting: "owner-v1",
      threadContextVersion: 2,
      groupGuidance: "owner-v1",
    });
    const detail = await h.api<{ thread: { ownerBotId?: string } }>(
      "GET",
      `/api/threads/${thread.id}`,
    );
    expect(detail.json.thread.ownerBotId).toBe(bots[0]?.id);
    // The owner's unaddressed answer walked nobody, and the others read it with their next wake.
    expect(ctx.runs.list({ threadId: thread.id })).toHaveLength(1);
    expect(
      ctx.threads.member(thread.id, bots[1]?.id as (typeof bots)[number]["id"])?.lastSeenSeq,
    ).toBe(0);
  });

  it("offers the next member with who passed, and says so when nobody replied", async () => {
    const { h, ctx, thread } = await group();
    const seen: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      seen.push(req);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(""),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "thanks all" });
    await waitFor(() => seen.length >= 3);
    await settle(h);
    expect(seen.map((r) => r.botName)).toEqual(["chief", "alice", "bob"]);
    const offers = seen.map((r) =>
      r.trigger.kind === "thread_message" ? r.trigger.routing?.offer : undefined,
    );
    expect(offers).toEqual([
      { messageSeq: 1, passed: [], remaining: ["alice", "bob"] },
      { messageSeq: 1, passed: ["chief"], remaining: ["bob"] },
      { messageSeq: 1, passed: ["chief", "alice"], remaining: [] },
    ]);
    const messages = ctx.messages.list(thread.id);
    expect(messages.at(-1)).toMatchObject({
      authorKind: "system",
      body: "No member replied to message #1: chief ended without a reply; alice ended without a reply; bob ended without a reply. Mention a member to assign it.",
    });
    expect(ctx.threads.mustGet(thread.id).ownerBotId).toBeUndefined();
    expect(ctx.runs.list({ threadId: thread.id })).toHaveLength(3);
  });

  it("an owner delegates by mention, is told the outcome, and answers, with no member walked", async () => {
    const { h, ctx, bots, thread } = await group();
    const seen: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      seen.push(req);
      const chiefTurns = seen.filter((r) => r.botName === "chief").length;
      const reply =
        req.botName === "alice"
          ? "The unit price is 4."
          : chiefTurns === 1
            ? "@alice what is the unit price of item K?"
            : "Item K costs 4 per unit.";
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(reply),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "What does item K cost?" });
    await waitFor(
      () =>
        seen.length >= 3 &&
        ctx.runs.list({ threadId: thread.id }).every((r) => isTerminal(r.status)),
    );
    await settle(h);
    // chief takes and delegates, alice answers without mentioning anyone, the Gateway's outcome
    // notice wakes the chief, the chief answers the human. bob is never woken.
    expect(seen.map((r) => r.botName)).toEqual(["chief", "alice", "chief"]);
    expect(ctx.threads.mustGet(thread.id).ownerBotId).toBe(bots[0]?.id);
    // Each run's delivered slice is on its row, so what it was asked can be read back later.
    expect(
      ctx.runs
        .list({ threadId: thread.id })
        .map((r) => [r.config.deliveredFromSeq, r.deliveredSeq]),
    ).toEqual([
      [0, 1],
      [0, 2],
      [1, 4],
    ]);
    const bodies = ctx.messages.list(thread.id).map((m) => `${m.authorKind}:${m.body}`);
    expect(bodies).toEqual([
      "human:What does item K cost?",
      "bot:@alice what is the unit price of item K?",
      "bot:The unit price is 4.",
      expect.stringContaining("system:Delegation outcome: alice finished the work"),
      "bot:Item K costs 4 per unit.",
    ]);
    const last = seen.at(-1);
    expect(last?.trigger).toMatchObject({
      routing: {
        members: [{ name: "chief", you: true, owner: true }, { name: "alice" }, { name: "bob" }],
      },
    });
    if (last?.trigger.kind === "thread_message") {
      expect(last.trigger.routing?.offer).toBeUndefined();
      expect(last.trigger.messages.map((m) => m.body)).toEqual([
        "The unit price is 4.",
        expect.stringContaining("Delegation outcome"),
      ]);
    }
  });

  it("thread_post answers with whom the message addressed and what only looks like an address", async () => {
    const { h, ctx, thread } = await group();
    const answers: unknown[] = [];
    let chiefRuns = 0;
    h.provider.onRun(async (req, gw) => {
      // Only the chief's first run posts; the notices that follow wake it again.
      if (req.botName === "chief" && ++chiefRuns === 1) {
        for (const body of [
          "@alice count item K",
          "@ bob, and you look up the price. cc @human",
          "@everyone status?",
        ]) {
          const res = await gw.post("messages", {
            type: "post_message",
            runId: req.runId,
            tool: "thread_post",
            body,
            attachments: [],
          });
          answers.push(((await res.json()) as { routing: unknown }).routing);
        }
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(""),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "@chief split this" });
    await waitFor(() => answers.length === 3);
    await waitFor(() => ctx.runs.list({ threadId: thread.id }).every((r) => isTerminal(r.status)));
    // Other runs post between the chief's three messages, so the seqs are whatever they were.
    const posted = ctx.messages.list(thread.id).filter((m) => m.authorKind === "bot");
    expect(answers).toEqual([
      { seq: posted[0]?.seq, addressed: ["alice"], everyone: false, unknown: [], spaced: [] },
      {
        seq: posted[1]?.seq,
        addressed: [],
        everyone: false,
        unknown: ["human"],
        spaced: ["bob"],
      },
      { seq: posted[2]?.seq, addressed: [], everyone: true, unknown: [], spaced: [] },
    ]);
    // The spaced name woke nobody: no run was triggered by that message.
    const spaced = posted[1];
    expect(spaced?.mentions).toEqual([]);
    expect(ctx.runs.list({ threadId: thread.id }).map((r) => r.triggerRef)).not.toContain(
      spaced?.id,
    );
  });

  it("a run whose row carries no routing knob is delivered as the walk routed it", async () => {
    const { h, ctx, bots, thread } = await group();
    h.app.deskmates.scheduler.stop();
    // A run row from before the knob existed: queued by the old router, started after upgrade.
    const message = ctx.messages.append({
      threadId: thread.id,
      authorKind: "human",
      authorId: "web",
      body: "old request",
      relayCount: 0,
    });
    const run = ctx.runs.create({
      botId: bots[0]?.id as (typeof bots)[number]["id"],
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: message.id,
      config: {},
    });
    const { request } = h.app.deskmates.lifecycle.start(run);
    expect(request.groupGuidance).toBeUndefined();
    expect(request.trigger).toMatchObject({ routing: { version: 1 } });
    if (request.trigger.kind === "thread_message") {
      expect(request.trigger.routing?.members).toBeUndefined();
    }
  });

  it("walk-v1 sends the version 1 routing context: no roster, no norm", async () => {
    const { h, ctx, thread } = await group(undefined, { groupRouting: "walk-v1" });
    const seen: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      seen.push(req);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(""),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "@chief hello" });
    await waitFor(() => seen.length >= 1);
    await settle(h);
    const [req] = seen;
    expect(req?.groupGuidance).toBeUndefined();
    if (req?.trigger.kind === "thread_message") {
      expect(req.trigger.routing).toEqual({
        version: 1,
        recipientBotId: req.botId,
        recipientName: "chief",
        sourceMessageSeq: 1,
      });
    }
    expect(ctx.runs.list({ threadId: thread.id })[0]?.config).toMatchObject({
      groupRouting: "walk-v1",
      threadContextVersion: 1,
    });
    expect(ctx.threads.mustGet(thread.id).ownerBotId).toBeUndefined();
  });
});
