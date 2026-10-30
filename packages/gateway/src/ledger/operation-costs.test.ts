// T1: operation receipts on the Costs report and in a run's spend (ADR-0040 amendment A,
// decisions 13 and 14), on an in-memory database with the real migrations.

import type { RunId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { OperationStore } from "../operations/operation-store.js";
import { CostQueryStore, runSpend } from "./costs.js";

let db: GatewayDb;
let costs: CostQueryStore;

function seedRun(id: string, botId: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at)
     VALUES ('ws', ?, ?, 'interactive', 'succeeded', 'thread_message', ?, ?)`,
  ).run(id, botId, id, createdAt);
}

function seedUsage(runId: string, model: string, input: number, costUsd: number | null): void {
  db.prepare(
    `INSERT INTO run_usage
       (run_id, attempt, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd)
     VALUES (?, 1, ?, ?, 0, 0, 0, ?)`,
  ).run(runId, model, input, costUsd);
}

function seedOperation(
  runId: string,
  input: {
    operation?: "look" | "asr";
    model?: string;
    status?: "succeeded" | "failed" | "refused";
    unit?: "image" | "page" | "audio_second";
    quantity: number | null;
    costUsd: number | null;
  },
): void {
  const status = input.status ?? "succeeded";
  new OperationStore(db).record({
    workspaceId: "ws",
    runId: runId as RunId,
    attempt: 1,
    operation: input.operation ?? "look",
    mode: (input.operation ?? "look") === "look" ? "ocr" : null,
    model: input.model ?? "vl-model",
    endpointSha256: "0".repeat(64),
    status,
    errorCode:
      status === "succeeded" ? null : status === "refused" ? "budget_exhausted" : "timed_out",
    unit: input.unit ?? "image",
    quantity: input.quantity,
    measured: input.quantity === null ? "unknown" : "computed",
    inputBytes: 10,
    inputSha256: null,
    inputTokens: 900,
    outputTokens: 20,
    latencyMs: 5,
    costUsd: input.costUsd,
  });
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
  seedRun("run-2", "bot-b", "2026-09-23T10:00:00.000Z");
  seedUsage("run-1", "chat-model", 100, 2);
  costs = new CostQueryStore(db);
});

describe("operations on the Costs report (decision 14)", () => {
  it("without operations the report carries no operation field and is unchanged", () => {
    const report = costs.report("tnt_default");
    expect(report.operations).toBeUndefined();
    expect(report.totals).toMatchObject({
      runCount: 1,
      usageCount: 1,
      knownCostUsd: 2,
      pricedUsageCount: 1,
      unpricedUsageCount: 0,
    });
  });

  it("adds operation money and counts, never tokens, to totals, days and bot rankings", () => {
    seedOperation("run-1", { quantity: 1, costUsd: 0.5 });
    seedOperation("run-1", { quantity: 1, costUsd: null });
    seedOperation("run-1", { status: "refused", quantity: null, costUsd: null });
    // An operations-only run on another day and bot.
    seedOperation("run-2", {
      operation: "asr",
      model: "whisper",
      unit: "audio_second",
      quantity: null,
      status: "failed",
      costUsd: null,
    });
    const report = costs.report("tnt_default");
    expect(report.totals).toMatchObject({
      runCount: 2,
      usageCount: 4,
      inputTokens: 100,
      outputTokens: 0,
      pricedUsageCount: 2,
      unpricedUsageCount: 2,
      unestimatedUsageCount: 1,
      knownCostUsd: 2.5,
      costStatus: "partial",
    });
    expect(report.days?.map((d) => [d.day, d.knownCostUsd, d.usageCount, d.inputTokens])).toEqual([
      ["2026-09-22", 2.5, 3, 100],
      ["2026-09-23", null, 1, 0],
    ]);
    expect(report.operations).toEqual({
      units: [
        { unit: "audio_second", callCount: 1, quantity: 0, unmeasuredCount: 1 },
        { unit: "image", callCount: 2, quantity: 2, unmeasuredCount: 0 },
      ],
      refusedCount: 1,
    });
    // Activity rows stay token rows of chat models.
    expect(report.rows.map((r) => r.model)).toEqual(["chat-model"]);

    const bots = costs.ranking("tnt_default", {}, "bot", "money");
    expect(bots.entries.map((e) => [e.label, e.knownCostUsd, e.runCount])).toEqual([
      ["Alpha", 2.5, 1],
      ["Beta", null, 1],
    ]);
    const models = costs.ranking("tnt_default", {}, "model", "money");
    expect(models.entries.map((e) => e.key)).toEqual(["chat-model"]);
  });

  it("ranks operations by money with an unpriced entry last and no money for it", () => {
    seedOperation("run-1", { quantity: 1, costUsd: 0.25 });
    seedOperation("run-1", { quantity: 2, costUsd: 0.5, unit: "page" });
    seedOperation("run-2", {
      operation: "asr",
      model: "whisper",
      unit: "audio_second",
      quantity: 30,
      costUsd: null,
    });
    const page = costs.ranking("tnt_default", {}, "operation", "money");
    expect(page.total).toBe(2);
    expect(page.entries).toEqual([
      expect.objectContaining({
        key: "look:vl-model",
        label: "look · vl-model",
        knownCostUsd: 0.75,
        runCount: 1,
        usageCount: 2,
        inputTokens: 0,
        costStatus: "priced",
      }),
      expect.objectContaining({
        key: "asr:whisper",
        knownCostUsd: null,
        unpricedUsageCount: 1,
        unestimatedUsageCount: 1,
        costStatus: "unpriced",
      }),
    ]);
  });

  it("matches the model filter against the operation's model", () => {
    seedOperation("run-1", { quantity: 1, costUsd: 0.5 });
    seedOperation("run-2", { model: "other-vl", quantity: 1, costUsd: 0.25 });
    const onlyVl = costs.report("tnt_default", { model: "other-vl" });
    expect(onlyVl.totals).toMatchObject({ runCount: 1, usageCount: 1, knownCostUsd: 0.25 });
    expect(onlyVl.operations?.units).toEqual([
      { unit: "image", callCount: 1, quantity: 1, unmeasuredCount: 0 },
    ]);
    const chat = costs.report("tnt_default", { model: "chat-model" });
    expect(chat.totals).toMatchObject({ runCount: 1, usageCount: 1, knownCostUsd: 2 });
    expect(chat.operations).toBeUndefined();
  });
});

describe("operation spend of a run (decisions 12 and 13)", () => {
  it("adds known cost, counts unknown quantities and missing prices, and never estimates", () => {
    // A token price exists, so a token estimate would be possible; an operation never gets one.
    db.prepare(
      `INSERT INTO prices (model, input_per_m, output_per_m, cache_read_per_m, cache_create_per_m, effective_from)
       VALUES ('chat-model', 3, 15, 0.3, 3.75, '2026-01-01T00:00:00.000Z')`,
    ).run();
    seedOperation("run-2", { quantity: 1, costUsd: 0.5 });
    seedOperation("run-2", { quantity: 4, costUsd: null });
    seedOperation("run-2", { status: "failed", quantity: null, costUsd: null });
    seedOperation("run-2", { status: "refused", quantity: null, costUsd: null });
    expect(runSpend(db, "run-2" as RunId)).toEqual({
      knownUsd: 0.5,
      estimatedUsd: 0,
      unmeasuredUsageCount: 1,
      unestimatedUsageCount: 1,
    });
  });
});
