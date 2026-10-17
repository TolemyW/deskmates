// T1: ADR-0026 amendment 1. A paused bot is woken by nothing new: a cron round and a chat mention
// create no run and say why (the private chat, the thread), a webhook is refused, and its queued
// runs wait. A live run is left alone and a parked run stays parked; nothing is cancelled or
// denied, which is what sets pause apart from Trash. Resuming starts what waited.

import type { BotDefinition, StartRunRequest } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, nextTurn, startHarness, waitFor } from "../test-support/harness.js";
import { hashWebhookToken, newWebhookToken } from "./webhook-token.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness({ cronTimeZone: "UTC" });
  h.provider.onRun(endRun);
});
afterEach(async () => {
  await h.close();
});

async function endRun(req: StartRunRequest, gw: FakeSidecarClient): Promise<void> {
  await gw.post("ended", {
    type: "run_ended",
    runId: req.runId,
    outcome: "completed",
    summary: {
      done: "answered",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "ok",
    },
    usage: [],
  });
}

const MINUTE = new Date("2026-10-15T09:00:00.000Z");
const NEXT_MINUTE = new Date("2026-10-15T09:01:00.000Z");

describe("pause (ADR-0026 amendment 1)", () => {
  it("skips a cron round and a chat mention with a visible reason, and refuses a webhook", async () => {
    const { bot, thread } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const chat = ctx.privateChats.resolve(bot.id);
    await h.api("PATCH", `/api/bots/${bot.id}`, {
      cron: [{ schedule: "* * * * *", prompt: "sweep" }],
    });
    const paused = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      paused: true,
    });
    expect(paused.json.bot.pausedAt).toBeTypeOf("string");
    expect(paused.json.bot.pausedBy).toBe("human:web");

    h.app.deskmates.cron.tick(MINUTE);
    h.app.deskmates.cron.tick(NEXT_MINUTE);
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      {
        body: "@alice are you there?",
      },
    );
    expect(posted.json.runs).toEqual([]);
    expect(ctx.runs.list({ botId: bot.id })).toEqual([]);

    // The seeded one-member chat is the bot's private chat: one notice per cron entry and pause
    // (two ticks, one line) and one for the mention.
    expect(chat.id).toBe(thread.id);
    const notices = ctx.messages
      .list(chat.id, 0)
      .filter((m) => m.authorKind === "system")
      .map((m) => m.body);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("Schedule 1 (* * * * *) did not run: alice is paused");
    expect(notices[1]).toContain("alice is paused and was not woken by message #");
    const token = newWebhookToken();
    ctx.bots.setWebhookTokenHash(bot.id, hashWebhookToken(token));
    const hook = await fetch(`${h.baseUrl}/hooks/${bot.id}/${token}`, {
      method: "POST",
      body: "payload",
    });
    expect(hook.status).toBe(409);
    expect(((await hook.json()) as { details: { reason: string } }).details.reason).toBe(
      "bot_paused",
    );
    const runNow = await h.api<{ code: string }>("POST", `/api/bots/${bot.id}/cron/0/run`, {});
    expect(runNow.status).toBe(409);
    expect(ctx.runs.list({ botId: bot.id })).toEqual([]);
  });

  it("passes a paused member over in a group: the request goes to an awake member", async () => {
    const { bot, workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const bob = ctx.bots.create({ name: "bob", role: "peer", workspaceId: workspace.id });
    const group = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id, bob.id] });
    await h.api("PATCH", `/api/bots/${bot.id}`, { paused: true });
    const unaddressed = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${group.id}/messages`,
      { body: "who can take this?" },
    );
    expect(unaddressed.json.runs.map((run) => run.botId)).toEqual([bob.id]);
    const everyone = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${group.id}/messages`,
      {
        body: "@everyone status?",
      },
    );
    expect(everyone.json.runs.every((run) => run.botId === bob.id)).toBe(true);
    expect(ctx.runs.list({ botId: bot.id })).toEqual([]);
    expect(
      ctx.messages.list(group.id, 0).filter((m) => m.body.startsWith("alice is paused")),
    ).toHaveLength(2);
  });

  it("leaves a live run and a parked run alone, holds a queued one, and resuming starts it", async () => {
    const { bot } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const make = (ref: string, status?: string) => {
      const run = ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: ref,
        triggerPayload: { body: ref },
        config: ctx.runConfig(),
      });
      if (status) ctx.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, run.id);
      return run;
    };
    const live = make("live", "running");
    const parked = make("parked", "waiting_approval");
    await h.api("PATCH", `/api/bots/${bot.id}`, { paused: true });
    ctx.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(live.id);
    const queued = make("queued");
    h.app.deskmates.scheduler.kick();
    await nextTurn();
    await nextTurn();
    expect(ctx.runs.mustGet(queued.id).status).toBe("queued");
    expect(ctx.runs.mustGet(parked.id).status).toBe("waiting_approval");
    expect(h.provider.execCalls).toHaveLength(0);
    const waiting = ctx.events.list(queued.id).find((e) => e.kind === "log");
    expect(waiting?.payload).toMatchObject({ source: "scheduler", waitReason: "bot_paused" });

    const resumed = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      paused: false,
    });
    expect(resumed.json.bot.pausedAt).toBeUndefined();
    await waitFor(() => ctx.runs.mustGet(queued.id).status === "succeeded", 3000, "held run");
    expect(ctx.runs.mustGet(parked.id).status).toBe("waiting_approval");
    const audits = ctx.audit
      .list({ targetId: bot.id })
      .filter((e) => e.action === "bot.update")
      .map((e) => e.after);
    expect(audits).toEqual([{ paused: false }, { paused: true }]);
  });
});
