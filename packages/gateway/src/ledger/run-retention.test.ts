// T1, ADR-0042 decision 6: with `RUN_EVENTS_RETENTION_DAYS` set, a terminal run that finished
// longer ago loses its events, usage rows and model requests and keeps its row, its Activity
// summary and its Costs summary; a run with an undecided approval, a run still going and a recent
// run keep everything; a second pass changes nothing; unset, nothing is pruned.

import type { ApprovalId, BotId, RunId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readRunsConfig } from "../config/runs.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { pruneRunLedger, prunedAt } from "./run-retention.js";
import { RunUsageSummaryStore } from "./run-usage-summaries.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const NOW = new Date("2026-10-15T00:00:00.000Z");

async function setup() {
  h = await startHarness();
  h.app.deskmates.scheduler.stop();
  const seeded = await h.seed();
  return { ctx: h.app.deskmates.ctx, ...seeded };
}

type Ctx = Harness["app"]["deskmates"]["ctx"];

/** A run with a ledger: two events, one usage row, one model request, finished at `at`. */
function runWithLedger(ctx: Ctx, botId: BotId, at: string, status: string): RunId {
  const run = ctx.runs.create({
    botId,
    lane: "background",
    triggerKind: "cron",
    triggerRef: `cron:${at}:${status}`,
  });
  ctx.events.append({ runId: run.id, kind: "log", payload: { source: "test", n: 1 } });
  ctx.events.append({ runId: run.id, kind: "log", payload: { source: "test", n: 2 } });
  ctx.db
    .prepare(
      `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 1, 'model-a', 1000, 200, 0.25)`,
    )
    .run(run.id);
  ctx.db
    .prepare(
      `INSERT INTO model_requests (run_id, attempt, seq, ts, request_kind, model, stream)
       VALUES (?, 1, 1, ?, 'messages', 'model-a', 1)`,
    )
    .run(run.id, at);
  ctx.db
    .prepare(
      "UPDATE runs SET status = ?, created_at = ?, started_at = ?, finished_at = ? WHERE id = ?",
    )
    .run(status, at, at, status === "running" ? null : at, run.id);
  return run.id;
}

function counts(ctx: Ctx, runId: RunId) {
  const n = (table: string) =>
    (
      ctx.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?`).get(runId) as {
        n: number;
      }
    ).n;
  return {
    runs: (
      ctx.db.prepare("SELECT count(*) AS n FROM runs WHERE id = ?").get(runId) as { n: number }
    ).n,
    events: n("run_events"),
    usage: n("run_usage"),
    requests: n("model_requests"),
    activity: n("run_activity_summaries"),
  };
}

describe("run ledger retention (ADR-0042 decision 6)", () => {
  it("prunes old terminal runs and keeps their row, Activity and Costs summaries", async () => {
    const { ctx, bot, workspace } = await setup();
    const old = runWithLedger(ctx, bot.id, "2026-09-01T00:00:00.000Z", "failed");
    const parked = runWithLedger(ctx, bot.id, "2026-09-01T00:01:00.000Z", "cancelled");
    const live = runWithLedger(ctx, bot.id, "2026-09-01T00:02:00.000Z", "running");
    const recent = runWithLedger(ctx, bot.id, "2026-10-14T00:00:00.000Z", "succeeded");
    ctx.db
      .prepare(
        `INSERT INTO run_activity_summaries (run_id, source_version, workspace_id, status, text,
           created_at, updated_at) VALUES (?, 'a1-failed', ?, 'ready', 'It failed.', ?, ?)`,
      )
      .run(old, workspace.id, NOW.toISOString(), NOW.toISOString());
    ctx.approvals.create({
      id: "apr_retention_1" as ApprovalId,
      runId: parked,
      botId: bot.id,
      action: { toolName: "Bash", input: { command: "deploy" } },
      riskLevel: "L2",
    });
    const summaries = new RunUsageSummaryStore(ctx.db);
    summaries.refresh([old]);
    const costBefore = summaries.get(old);
    expect(costBefore?.models[0]?.knownCostUsd).toBe(0.25);

    // Off by default: nothing happens.
    expect(pruneRunLedger(ctx.db, undefined, NOW)).toEqual({
      runs: 0,
      events: 0,
      usage: 0,
      requests: 0,
    });
    expect(counts(ctx, old).events).toBeGreaterThan(0);

    const result = pruneRunLedger(ctx.db, 30, NOW);
    expect(result.runs).toBe(1);
    expect(counts(ctx, old)).toEqual({ runs: 1, events: 0, usage: 0, requests: 0, activity: 1 });
    expect(summaries.get(old)).toEqual(costBefore);
    expect(prunedAt(ctx.db, old)).toBeDefined();
    expect(ctx.runs.mustGet(old).status).toBe("failed");
    for (const kept of [parked, live, recent]) {
      expect(counts(ctx, kept).events, kept).toBeGreaterThan(0);
      expect(counts(ctx, kept).usage, kept).toBe(1);
      expect(counts(ctx, kept).requests, kept).toBe(1);
      expect(prunedAt(ctx.db, kept)).toBeUndefined();
    }

    // Idempotent: the pruned run is recorded and not touched again.
    expect(pruneRunLedger(ctx.db, 30, NOW).runs).toBe(0);
    expect(summaries.get(old)).toEqual(costBefore);

    // Once the approval is decided, the parked run is an ordinary old run.
    ctx.approvals.decide("apr_retention_1" as ApprovalId, "deny", "human:owner");
    expect(pruneRunLedger(ctx.db, 30, NOW).runs).toBe(1);
    expect(counts(ctx, parked).events).toBe(0);
  });

  it("reads RUN_EVENTS_RETENTION_DAYS as off when empty or 0 and refuses anything else", () => {
    expect(readRunsConfig({}).runEventsRetentionDays).toBeUndefined();
    expect(
      readRunsConfig({ RUN_EVENTS_RETENTION_DAYS: "0" }).runEventsRetentionDays,
    ).toBeUndefined();
    expect(readRunsConfig({ RUN_EVENTS_RETENTION_DAYS: "90" }).runEventsRetentionDays).toBe(90);
    expect(() => readRunsConfig({ RUN_EVENTS_RETENTION_DAYS: "-3" })).toThrow(/RUN_EVENTS/);
    expect(() => readRunsConfig({ RUN_EVENTS_RETENTION_DAYS: "soon" })).toThrow(/RUN_EVENTS/);
  });
});
