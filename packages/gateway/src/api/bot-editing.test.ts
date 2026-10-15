// T1: ADR-0043 decision 1. Every bot field but its workspace is editable after create: name,
// role, connectors, message allowlist, effort and thinking through `PATCH /api/bots/:id`, and each
// reaches the next run. A rename keeps `[\w-]+` and per-workspace uniqueness, moves the bot's
// directories in the container first, and keeps the private chat title and the peers'
// `message_bot` allowlists pointing at the bot.

import type { BotDefinition, StartRunRequest, Thread } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { postDirectMessage } from "../threads/direct-messages.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

/** What "the sidecar" was asked to do: a run, or the `bot-rename` maintenance command. */
type Exec = StartRunRequest & { from?: string; to?: string };
const renames: { from: string; to: string }[] = [];

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

function playSidecar(): void {
  renames.length = 0;
  h.provider.onRun(async (raw, gw) => {
    const req = raw as Exec;
    if (req.from !== undefined && req.to !== undefined) {
      renames.push({ from: req.from, to: req.to });
      return { stdout: JSON.stringify({ moved: [`/home/${req.to}`] }) };
    }
    await endRun(req, gw);
    return undefined;
  });
}

async function runOnce(thread: Thread): Promise<{ run: RunRecord; request: StartRunRequest }> {
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "go",
  });
  const run = posted.json.runs[0] as RunRecord;
  await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded", 3000, "run");
  const call = h.provider.execCalls.find((c) => c.request.runId === run.id);
  return {
    run: h.app.deskmates.ctx.runs.mustGet(run.id),
    request: call?.request as StartRunRequest,
  };
}

describe("PATCH /api/bots/:id: the fields that were create-time (ADR-0043 decision 1)", () => {
  it("persists role, connectors, allowlist, effort and thinking, and the next run gets them", async () => {
    const { bot, thread } = await h.seed();
    playSidecar();
    const res = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      role: "  reviewer ",
      connectors: ["warehouse", "warehouse", " "],
      messageAllowlist: ["bob"],
      effort: "low",
      thinking: { type: "disabled" },
    });
    expect(res.status).toBe(200);
    expect(res.json.bot).toMatchObject({
      role: "reviewer",
      connectors: ["warehouse"],
      messageAllowlist: ["bob"],
      effort: "low",
      thinking: { type: "disabled" },
    });
    const got = await h.api<{ bot: BotDefinition }>("GET", `/api/bots/${bot.id}`);
    expect(got.json.bot).toEqual(res.json.bot);
    const { run, request } = await runOnce(thread);
    expect(request.connectors).toEqual(["warehouse"]);
    expect(request.effort).toBe("low");
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(run.config.reasoning).toMatchObject({ effort: "low", thinking: { type: "disabled" } });
    const audit = h.app.deskmates.ctx.audit
      .list({ targetId: bot.id })
      .find((event) => event.action === "bot.update");
    expect(audit?.before).toMatchObject({ role: "tester", connectors: [], effort: null });
    expect(audit?.after).toMatchObject({ role: "reviewer", connectors: ["warehouse"] });
  });

  it("renames: directories moved first, chat title, peers' allowlists and the next run follow", async () => {
    const { bot, thread, workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    playSidecar();
    const peer = ctx.bots.create({
      name: "bob",
      role: "peer",
      workspaceId: workspace.id,
      messageAllowlist: ["ALICE", "carol"],
    });
    const chat = ctx.privateChats.resolve(bot.id);
    expect(chat.title).toBe("alice");
    const res = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      name: "alicia",
    });
    expect(res.status).toBe(200);
    expect(res.json.bot.name).toBe("alicia");
    expect(renames).toEqual([{ from: "alice", to: "alicia" }]);
    expect(ctx.threads.mustGet(chat.id).title).toBe("alicia");
    expect(ctx.threads.mustGet(thread.id).title).toBe("alicia");
    expect(ctx.bots.mustGet(peer.id).messageAllowlist).toEqual(["alicia", "carol"]);
    // The peer's `message_bot` to the new name routes; the old name no longer exists.
    const peerRun = ctx.runs.create({
      botId: peer.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "peer",
      triggerPayload: { body: "" },
    });
    expect(postDirectMessage(ctx, peerRun, "alicia", "hello", []).message.body).toBe("hello");
    expect(() => postDirectMessage(ctx, peerRun, "alice", "hello", [])).toThrow("another bot");
    const { request } = await runOnce(thread);
    expect(request.botName).toBe("alicia");
    expect(request.botHomeDir).toBe("/home/alicia");
  });

  it("keeps the name rules and refuses a rename while the bot has a live or parked run", async () => {
    const { bot, workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    playSidecar();
    ctx.bots.create({ name: "bob", role: "", workspaceId: workspace.id });
    for (const name of ["bad name", "a/b", "", "BOB"]) {
      const res = await h.api<{ code: string }>("PATCH", `/api/bots/${bot.id}`, { name });
      expect(res.status, name).toBe(400);
      expect(res.json.code).toBe("validation");
    }
    const live = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "busy",
      triggerPayload: { body: "" },
    });
    ctx.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(live.id);
    const busy = await h.api<{ code: string }>("PATCH", `/api/bots/${bot.id}`, { name: "alicia" });
    expect(busy.json.code).toBe("lane_busy");
    ctx.db.prepare("UPDATE runs SET status = 'waiting_approval' WHERE id = ?").run(live.id);
    const parked = await h.api<{ code: string }>("PATCH", `/api/bots/${bot.id}`, {
      name: "alicia",
    });
    expect(parked.json.code).toBe("invalid_transition");
    expect(renames).toEqual([]);
    expect(ctx.bots.mustGet(bot.id).name).toBe("alice");
  });

  it("commits nothing when the container refuses the move", async () => {
    const { bot } = await h.seed();
    h.provider.onRun(async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ error: "/home/alicia already exists and is not empty" }),
    }));
    const res = await h.api<{ code: string; message: string }>("PATCH", `/api/bots/${bot.id}`, {
      name: "alicia",
    });
    expect(res.status).toBe(409);
    expect(res.json.message).toContain("not empty");
    expect(h.app.deskmates.ctx.bots.mustGet(bot.id).name).toBe("alice");
  });
});
