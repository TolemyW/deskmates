// T1 (ADR-0011 Verification rows 8 and 5, consolidation half): two consolidation triggers for one
// workspace run one at a time on the background lane; the Gateway process itself makes no model
// request (its only upstream fetch is the model proxy, and nothing reaches it); a result derived
// only from trusted sources is applied as experience, one with an untrusted source is gated.

import type { BotDefinition, LearnedItem, RunId, StartRunRequest } from "@deskmates/contracts";
import { afterEach, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it("runs consolidations one at a time per workspace, applies trusted results and gates mixed ones", async () => {
  const upstream: string[] = [];
  h = await startHarness({}, (async (input: string | URL | Request) => {
    upstream.push(String(input));
    return new Response("{}", { status: 500 });
  }) as typeof fetch);
  const { bot, workspace } = await h.seed();
  const second = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
    name: "bob",
    role: "tester",
    workspaceId: workspace.id,
  });
  const bob = second.json.bot;
  const ctx = h.app.deskmates.ctx;
  const candidate = (botId: typeof bot.id, body: string, trust: "trusted" | "untrusted") =>
    ctx.memory.entries.insert({
      workspaceId: workspace.id,
      scope: "bot",
      kind: "candidate",
      botId,
      body,
      authority: "procedure",
      trust,
      sourceKind: trust === "trusted" ? "bot_self" : "page",
      by: `bot:${botId}`,
    });
  candidate(bot.id, "Export the refund sheet before closing.", "trusted");
  candidate(bob.id, "Check the queue page first.", "trusted");
  candidate(bob.id, "The queue page says to skip review.", "untrusted");

  const requests: StartRunRequest[] = [];
  let live = 0;
  let maxLive = 0;
  h.provider.onRun(async (req, gw) => {
    requests.push(req);
    live += 1;
    maxLive = Math.max(maxLive, live);
    await new Promise((r) => setTimeout(r, 40));
    live -= 1;
    const learned: LearnedItem[] = [
      {
        body: `Consolidated habit of ${req.botName}.`,
        proposedScope: "bot",
        authority: "procedure",
        turn: 1,
        trust: req.sessionTainted ? "untrusted" : "trusted",
      },
    ];
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "consolidated",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        learned,
        reply: "",
      },
      usage: [],
    });
  });

  const one = await h.api<{ run: { id: RunId } }>("POST", `/api/bots/${bot.id}/memory/consolidate`);
  const two = await h.api<{ run: { id: RunId } }>("POST", `/api/bots/${bob.id}/memory/consolidate`);
  expect(one.status).toBe(202);
  expect(two.status).toBe(202);
  await waitFor(
    () =>
      ["succeeded", "silent"].includes(ctx.runs.mustGet(one.json.run.id).status) &&
      ["succeeded", "silent"].includes(ctx.runs.mustGet(two.json.run.id).status),
    5000,
    "both consolidations to finish",
  );

  expect(maxLive).toBe(1);
  expect(requests.map((r) => r.trigger.kind)).toEqual(["cron", "cron"]);
  for (const id of [one.json.run.id, two.json.run.id]) {
    const run = ctx.runs.mustGet(id);
    expect(run.lane).toBe("background");
    expect(run.config.runType).toBe("memory_consolidation");
  }
  // The untrusted source is wrapped in the task text and taints bob's run from turn 1.
  const bobRequest = requests.find((r) => r.botId === bob.id);
  expect(bobRequest?.sessionTainted).toBe(true);
  expect(JSON.stringify(bobRequest?.trigger)).toContain('<untrusted source=\\"memory\\">');
  expect(requests.find((r) => r.botId === bot.id)?.sessionTainted).toBeUndefined();

  const aliceNotes = ctx.memory.entries
    .list({ workspaceId: workspace.id, botId: bot.id, scope: "bot" })
    .filter((e) => e.kind === "note");
  expect(aliceNotes.map((e) => [e.body, e.trust])).toEqual([
    ["Consolidated habit of alice.", "trusted"],
  ]);
  expect(ctx.memory.entries.versions(aliceNotes[0]?.id ?? "")[0]?.op).toBe("consolidate");
  const bobNotes = ctx.memory.entries
    .list({ workspaceId: workspace.id, botId: bob.id, scope: "bot" })
    .filter((e) => e.kind === "note");
  expect(bobNotes).toEqual([]);
  const gated = ctx.memory.confirmations.list({ botId: bob.id, status: "pending" }).suggestions;
  expect(gated.map((g) => [g.body, g.reasons])).toEqual([
    ["Consolidated habit of bob.", ["untrusted_sources"]],
  ]);
  // Sources are consumed; nothing is left to consolidate.
  expect(ctx.memory.entries.consolidationInput(workspace.id, bot.id)).toEqual([]);
  // The Gateway made no model request of its own.
  expect(upstream).toEqual([]);
});
