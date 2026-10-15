// T1: ADR-0005 amendment 6 (proposed) through the Gateway's run lifecycle, with the scheduler
// stopped and each run started and ended by hand the way the sidecar would end it (fake ends, no
// model, no Docker): the triage job's request and answer, the plan in each worker's and the
// closer's delivery, the unchanged group system prompt flag, fallback on a failed job, and the
// final-reply feedback of decision 50.

import {
  type MessageId,
  type RunEnded,
  type RunId,
  type StartRunRequest,
  type ThreadMessageTrigger,
  isTerminal,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./test-support/harness.js";
import { RoundPlanStore } from "./threads/round-plans.js";

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

const completed = (runId: RunId, reply: string): RunEnded => ({
  type: "run_ended",
  runId,
  outcome: "completed",
  usage: [],
  summary: summary(reply),
});

async function group() {
  const h = await startHarness({ groupRouting: "round-v1" });
  harnesses.push(h);
  h.app.deskmates.scheduler.stop();
  const ctx = h.app.deskmates.ctx;
  const lifecycle = h.app.deskmates.lifecycle;
  const ws = ctx.workspaces.create({ name: "group", sandboxProvider: "docker" });
  const [lead, prices, stock] = ["lead", "prices", "stock"].map((name) =>
    ctx.bots.create({ name, role: `${name} role`, workspaceId: ws.id }),
  ) as [
    ReturnType<typeof ctx.bots.create>,
    ReturnType<typeof ctx.bots.create>,
    ReturnType<typeof ctx.bots.create>,
  ];
  const thread = ctx.threads.create({
    workspaceId: ws.id,
    botIds: [prices.id, lead.id, stock.id],
  });
  const queued = () => ctx.runs.list({ threadId: thread.id }).filter((r) => r.status === "queued");
  const routingOf = (request: StartRunRequest) => (request.trigger as ThreadMessageTrigger).routing;
  return { h, ctx, lifecycle, ws, lead, prices, stock, thread, queued, routingOf };
}

describe("round-v1 through the run lifecycle", () => {
  it("triages on the cheap model, delivers the plan, and wakes the closer once with outcomes", async () => {
    const g = await group();
    const { ctx, lifecycle } = g;
    const posted = ctx.router.postHuman({
      threadId: g.thread.id,
      body: "What is the total stock value of item K?",
    });
    const [triage] = posted.runs;
    if (!triage) throw new Error("no triage run");

    const job = lifecycle.start(triage);
    expect(job.request.model).toBe("test-model-cheap");
    expect(job.request.maxTurns).toBe(1);
    expect(job.request.modelJob).toEqual({
      kind: "round_triage",
      roster: [
        { name: "prices", role: "prices role" },
        { name: "lead", role: "lead role" },
        { name: "stock", role: "stock role" },
      ],
      everyone: false,
      request: "What is the total stock value of item K?",
    });
    lifecycle.ended(
      triage.id,
      completed(
        triage.id,
        '{"assignments":[{"member":"prices","task":"unit price of K"},{"member":"@stock","task":"units of K in stock"},{"member":"nobody","task":"x"}],"closer":"lead"}',
      ),
    );
    expect(ctx.runs.mustGet(triage.id).status).toBe("succeeded");
    const work = g.queued();
    expect(work.map((r) => r.botId).sort()).toEqual([g.prices.id, g.stock.id].sort());
    expect(ctx.threads.mustGet(g.thread.id).ownerBotId).toBe(g.lead.id);

    const pricesRun = work.find((r) => r.botId === g.prices.id);
    const stockRun = work.find((r) => r.botId === g.stock.id);
    if (!pricesRun || !stockRun) throw new Error("missing worker runs");
    const started = lifecycle.start(pricesRun);
    // The system prompt flag is the owner-v1 one: the round text goes in the first user turn.
    expect(started.request.groupGuidance).toBe("owner-v1");
    expect(g.routingOf(started.request)?.round).toEqual({
      messageSeq: posted.message.seq,
      phase: "work",
      assignments: [
        { name: "prices", task: "unit price of K", you: true },
        { name: "stock", task: "units of K in stock" },
      ],
      closer: "lead",
    });
    expect(g.routingOf(started.request)?.members?.map((m) => m.name)).toEqual([
      "prices",
      "lead",
      "stock",
    ]);
    lifecycle.ended(pricesRun.id, completed(pricesRun.id, "K costs 5 per unit."));
    expect(g.queued()).toHaveLength(1);

    lifecycle.start(stockRun);
    lifecycle.ended(stockRun.id, completed(stockRun.id, ""));
    const [closer] = g.queued();
    if (!closer) throw new Error("no closer run");
    expect(closer.botId).toBe(g.lead.id);
    const closing = lifecycle.start(closer);
    const round = g.routingOf(closing.request)?.round;
    expect(round).toMatchObject({ phase: "close", closer: "lead", youClose: true });
    expect(round?.outcomes).toEqual([
      { name: "prices", outcome: "replied", seqs: [posted.message.seq + 1] },
      { name: "stock", outcome: "silent", seqs: [] },
    ]);
    const trigger = closing.request.trigger as ThreadMessageTrigger;
    expect(trigger.messages.some((m) => m.body === "K costs 5 per unit.")).toBe(true);
    lifecycle.ended(closer.id, completed(closer.id, "Item K: price 5, stock unknown."));
    expect(g.queued()).toEqual([]);
    const plan = new RoundPlanStore(ctx.db).get(posted.message.id as MessageId);
    expect(plan?.phase).toBe("closed");
    const view = ctx.rounds.get(posted.message.id);
    expect(view?.plan?.synthesisMessageIds).toHaveLength(1);
    expect(view?.members.map((m) => m.state)).toEqual(["replied", "skipped", "silent"]);
    expect(ctx.runs.list({ threadId: g.thread.id }).every((r) => isTerminal(r.status))).toBe(true);
  });

  it("falls back to the owner-first offer when the triage job fails", async () => {
    const g = await group();
    const posted = g.ctx.router.postHuman({ threadId: g.thread.id, body: "anyone?" });
    const [triage] = posted.runs;
    if (!triage) throw new Error("no triage run");
    g.lifecycle.start(triage);
    g.lifecycle.ended(triage.id, {
      type: "run_ended",
      runId: triage.id,
      outcome: "failed",
      usage: [],
      error: "upstream 503",
    });
    const [offered] = g.queued();
    expect(offered?.botId).toBe(g.prices.id);
    expect(g.ctx.walks.get(posted.message.id)?.mode).toBe("first_taker");
  });

  it("falls back when the job answers with no valid plan", async () => {
    const g = await group();
    const posted = g.ctx.router.postHuman({ threadId: g.thread.id, body: "anyone?" });
    const [triage] = posted.runs;
    if (!triage) throw new Error("no triage run");
    g.lifecycle.start(triage);
    g.lifecycle.ended(triage.id, completed(triage.id, "I think prices should do it."));
    expect(g.ctx.runs.mustGet(triage.id).status).toBe("failed");
    expect(g.queued().map((r) => r.botId)).toEqual([g.prices.id]);
    expect(g.ctx.events.list(triage.id).some((e) => e.payload.source === "round_triage")).toBe(
      true,
    );
  });

  it("tells a bot on its next wake that its final reply addressed nobody", async () => {
    const g = await group();
    const first = g.ctx.router.postHuman({ threadId: g.thread.id, body: "@prices hi" }).runs[0];
    if (!first) throw new Error("no run");
    g.lifecycle.start(first);
    g.lifecycle.ended(first.id, completed(first.id, "@stocks please count K"));
    expect(g.ctx.runs.mustGet(first.id).config.finalReplyRouting).toMatchObject({
      unknown: ["stocks"],
    });
    const next = g.ctx.router.postHuman({ threadId: g.thread.id, body: "@prices again" }).runs[0];
    if (!next) throw new Error("no second run");
    const started = g.lifecycle.start(next);
    expect(g.routingOf(started.request)?.lastReply).toMatchObject({
      unknown: ["stocks"],
      addressed: [],
    });
    g.lifecycle.ended(next.id, completed(next.id, "done"));
    const third = g.ctx.router.postHuman({ threadId: g.thread.id, body: "@prices once more" })
      .runs[0];
    if (!third) throw new Error("no third run");
    // Reported once: the run after it recorded nothing.
    expect(g.routingOf(g.lifecycle.start(third).request)?.lastReply).toBeUndefined();
  });
});
