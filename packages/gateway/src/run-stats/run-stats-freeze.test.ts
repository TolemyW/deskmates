// T1 (ADR-0050 decisions 7 and 8): `run_stats` is off by default on every run, frozen in
// `runs.config_json.runStats` when attempt 1 starts, kept by a later process whatever the
// setting says then, never given to a Gateway job, absent from the sidecar's tools when off,
// and refused by the route to a run that froze `off`.

import type { RunId, StartRunRequest } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { runStatsSettings } from "./run-stats-setting.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const ended = (runId: string) => ({
  type: "run_ended",
  runId,
  outcome: "completed",
  summary: {
    done: "ok",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply: "ok",
  },
  usage: [],
});

describe("run_stats freeze", () => {
  it("is off by default on every run, and frozen on with the tool when the bot has it", async () => {
    const { workspace, bot, thread } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const peer = ctx.bots.create({ name: "bob", role: "peer", workspaceId: workspace.id });
    const peerThread = ctx.threads.create({ workspaceId: workspace.id, botIds: [peer.id] });
    expect((await h.api("PUT", `/api/bots/${bot.id}/run-stats`, { enabled: true })).status).toBe(
      200,
    );

    const starts: StartRunRequest[] = [];
    const answers = new Map<string, number>();
    h.provider.onRun(async (req, gw) => {
      starts.push(req);
      answers.set(req.runId, (await gw.get("run-stats")).status);
      await gw.post("ended", ended(req.runId));
    });
    const runs: RunRecord[] = [];
    for (const t of [thread, peerThread]) {
      const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${t.id}/messages`, {
        body: "how am I doing?",
      });
      runs.push(posted.json.runs[0] as RunRecord);
    }
    await waitFor(
      () => runs.every((r) => ctx.runs.mustGet(r.id).status === "succeeded"),
      3000,
      "runs",
    );
    const [mine, theirs] = runs.map((r) => ctx.runs.mustGet(r.id)) as [RunRecord, RunRecord];
    expect(mine.config.runStats).toBe("self-v1");
    expect(theirs.config.runStats).toBe("off");
    const toolsOf = (id: RunId) => starts.find((s) => s.runId === id)?.tools ?? [];
    expect(toolsOf(mine.id)).toContain("run_stats");
    expect(toolsOf(theirs.id)).not.toContain("run_stats");
    expect(answers.get(mine.id)).toBe(200);
    expect(answers.get(theirs.id)).toBe(403);
  });

  it("keeps the frozen value on a later process, and never gives a job the tool", () => {
    const ctx = h.app.deskmates.ctx;
    const ws = ctx.workspaces.create({ name: "w", sandboxProvider: "docker" });
    const bot = ctx.bots.create({ workspaceId: ws.id, name: "nova", role: "r" });
    const store = runStatsSettings(ctx);
    const create = (config: Record<string, unknown> = {}) =>
      ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "cron",
        triggerRef: "0",
        config,
      });

    // Off by default: attempt 1 freezes off.
    const first = create();
    expect(store.startMode(ctx.runs, first, ws.id)).toBe("off");
    expect(ctx.runs.mustGet(first.id).config.runStats).toBe("off");

    store.set(bot, true, "user:test");
    const on = create();
    expect(store.startMode(ctx.runs, on, ws.id)).toBe("self-v1");
    // The setting goes off; the started run's next process keeps what it froze.
    store.set(bot, false, "user:test");
    const resumed = { ...ctx.runs.mustGet(on.id), attempt: 2, status: "waiting_approval" as const };
    expect(store.startMode(ctx.runs, resumed, ws.id)).toBe("self-v1");
    // And the reverse: frozen off stays off after the setting goes on.
    store.set(bot, true, "user:test");
    const later = {
      ...ctx.runs.mustGet(first.id),
      attempt: 2,
      status: "waiting_approval" as const,
    };
    expect(store.startMode(ctx.runs, later, ws.id)).toBe("off");

    // A Gateway job never has it, even for a bot with the setting.
    const job = create({ runType: "activity_summary" });
    expect(store.startMode(ctx.runs, job, ws.id)).toBe("off");
    // A run from before ADR-0050, already past its first start, never gains it.
    const legacy = { ...create(), attempt: 2, status: "waiting_approval" as const };
    ctx.runs.setConfig(legacy.id, {});
    expect(store.startMode(ctx.runs, { ...legacy, config: {} }, ws.id)).toBe("off");
  });
});
