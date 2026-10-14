import type { BotId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { CostQueryStore } from "./costs.js";

let db: GatewayDb;
let costs: CostQueryStore;

function seedRun(id: string, botId: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at)
     VALUES ('ws', ?, ?, 'interactive', 'succeeded', 'thread_message', ?, ?)`,
  ).run(id, botId, id, createdAt);
}

function seedUsage(
  runId: string,
  attempt: number,
  model: string,
  counts: [number, number, number, number],
  costUsd: number | null,
): void {
  db.prepare(
    `INSERT INTO run_usage
       (run_id, attempt, model, input_tokens, output_tokens,
        cache_read_tokens, cache_create_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, attempt, model, ...counts, costUsd);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws', 'tnt_default', 'Ops', 'docker', 'ready', '2026-09-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('bot-a', 'ws', 'Alpha', '', '2026-09-01T00:00:00.000Z'), ('bot-b', 'ws', 'Beta', '', '2026-09-01T00:00:00.000Z')",
  ).run();
  seedRun("run-1", "bot-a", "2026-09-22T10:00:00.000Z");
  seedRun("run-2", "bot-a", "2026-09-23T10:00:00.000Z");
  seedRun("run-3", "bot-b", "2026-09-22T11:00:00.000Z");
  seedUsage("run-1", 1, "model-a", [10, 2, 3, 4], 2);
  seedUsage("run-1", 2, "model-a", [20, 5, 6, 7], null);
  seedUsage("run-2", 1, "model-b", [30, 8, 9, 10], null);
  seedUsage("run-3", 1, "model-a", [40, 11, 12, 13], 1);
  costs = new CostQueryStore(db);
});

describe("CostQueryStore", () => {
  it("groups every token kind by UTC day, bot and model with explicit partial pricing", () => {
    const report = costs.report("tnt_default");

    expect(report.totals).toMatchObject({
      runCount: 3,
      usageCount: 4,
      inputTokens: 100,
      outputTokens: 26,
      cacheReadTokens: 30,
      cacheCreateTokens: 34,
      pricedUsageCount: 2,
      unpricedUsageCount: 2,
      knownCostUsd: 3,
      costStatus: "partial",
    });
    expect(report.rows).toHaveLength(3);
    expect(
      report.rows.find((row) => row.day === "2026-09-22" && row.botName === "Alpha"),
    ).toMatchObject({
      model: "model-a",
      runCount: 1,
      usageCount: 2,
      inputTokens: 30,
      outputTokens: 7,
      cacheReadTokens: 9,
      cacheCreateTokens: 11,
      pricedUsageCount: 1,
      unpricedUsageCount: 1,
      knownCostUsd: 2,
      costStatus: "partial",
    });
  });

  it("filters inclusive dates, bot and exact model", () => {
    const report = costs.report("tnt_default", {
      from: "2026-09-22",
      to: "2026-09-22",
      botId: "bot-a" as BotId,
      model: "model-a",
    });
    expect(report.filters).toEqual({
      from: "2026-09-22",
      to: "2026-09-22",
      botId: "bot-a",
      model: "model-a",
    });
    expect(report.rows).toHaveLength(1);
    expect(report.totals).toMatchObject({ runCount: 1, usageCount: 2, costStatus: "partial" });
  });

  it("uses null rather than zero when no matching usage has a known price", () => {
    const report = costs.report("tnt_default", { model: "model-b" });
    expect(report.totals).toMatchObject({
      usageCount: 1,
      knownCostUsd: null,
      pricedUsageCount: 0,
      unpricedUsageCount: 1,
      costStatus: "unpriced",
    });
    expect(report.rows[0]?.knownCostUsd).toBeNull();

    const empty = costs.report("tnt_default", { model: "missing" });
    expect(empty.rows).toEqual([]);
    expect(empty.totals).toMatchObject({ usageCount: 0, knownCostUsd: null });
  });
});
