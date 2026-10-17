// T0: the stored per-run usage summaries (ADR-0032 amendment 1, issue #113). The SQL-grouped
// Costs report, rows, days and rankings equal the earlier per-request computation on fixtures
// covering finals, proxy and SDK observations, an in-flight run, uncertain attribution, estimated,
// unestimated and unmeasured rows and a run that never started; a summary is stored once,
// invalidated by any write to its inputs, recomputed by the next reader, and never re-priced.

import type {
  BotId,
  CostQuery,
  CostRankingDimension,
  CostRankingMetric,
  RunId,
  WorkspaceId,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { LegacyCostQueryStore } from "../test-support/legacy-cost-report.js";
import { CostQueryStore } from "./costs.js";
import { EventStore } from "./events.js";
import { ModelRequestStore } from "./model-requests.js";
import { PriceStore } from "./prices.js";
import { RunUsageSummaryStore, refreshRunUsageSummary } from "./run-usage-summaries.js";

const T = "tnt_default";
let db: GatewayDb;
let events: EventStore;
let requests: ModelRequestStore;
let prices: PriceStore;

function run(
  id: string,
  ws: string,
  bot: string,
  status: string,
  createdAt: string,
  startedAt: string | null = createdAt,
): void {
  db.prepare(
    `INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref,
       created_at, started_at)
     VALUES (?, ?, ?, 'interactive', ?, 'thread_message', ?, ?, ?)`,
  ).run(ws, id, bot, status, id, createdAt, startedAt);
}

function final(
  runId: string,
  attempt: number,
  model: string,
  counts: [number, number, number, number],
  costUsd: number | null,
): void {
  db.prepare(
    `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens,
       cache_read_tokens, cache_create_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, attempt, model, ...counts, costUsd);
}

function turnUsage(runId: string, turn: number, model: string, inputTokens: number): void {
  events.append({
    runId: runId as RunId,
    attempt: 1,
    kind: "turn_usage",
    payload: {
      model,
      turn,
      inputTokens,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    },
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  events = new EventStore(db);
  requests = new ModelRequestStore(db);
  prices = new PriceStore(db);
  db.prepare(
    `INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES
       ('ws', 'tnt_default', 'Ops', 'docker', 'ready', '2026-09-01T00:00:00.000Z'),
       ('ws2', 'tnt_default', 'Lab', 'docker', 'ready', '2026-09-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES
       ('bot-a', 'ws', 'Alpha', '', '2026-09-01T00:00:00.000Z'),
       ('bot-b', 'ws', 'Beta', '', '2026-09-01T00:00:00.000Z'),
       ('bot-c', 'ws2', 'Alpha', '', '2026-09-01T00:00:00.000Z')`,
  ).run();
  prices.upsert({
    model: "model-a",
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheCreatePerM: 3.75,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  });
  prices.upsert({
    model: "model-b",
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.1,
    cacheCreatePerM: 1.25,
    effectiveFrom: "2026-09-23T00:00:00.000Z",
  });
  // Finals: priced, unpriced (estimated from the average of the configured models).
  run("r1", "ws", "bot-a", "succeeded", "2026-09-22T10:00:00.000Z");
  final("r1", 1, "model-a", [10, 2, 3, 4], 2);
  final("r1", 2, "model-a", [20, 5, 6, 7], null);
  run("r2", "ws", "bot-a", "succeeded", "2026-09-23T10:00:00.000Z");
  final("r2", 1, "model-x", [30, 8, 9, 10], null);
  run("r3", "ws", "bot-b", "succeeded", "2026-09-22T11:00:00.000Z");
  final("r3", 1, "model-a", [40, 11, 12, 13], 1);
  final("r3", 1, "model-b", [1000, 100, 0, 0], 0.0015);
  // In flight: SDK observations only (observational unpriced rows).
  run("r4", "ws", "bot-b", "running", "2026-09-23T12:00:00.000Z");
  turnUsage("r4", 1, "model-y", 100);
  turnUsage("r4", 2, "model-y", 150);
  // Never started.
  run("r5", "ws", "bot-a", "queued", "2026-09-23T13:00:00.000Z", null);
  // Failed with proxy observations: one priced served model, one request without usage.
  run("r6", "ws2", "bot-c", "failed", "2026-09-22T09:00:00.000Z");
  const served = requests.insert({
    runId: "r6" as RunId,
    attempt: 1,
    requestKind: "messages",
    model: "alias",
    stream: true,
    ts: "2026-09-22T09:00:01.000Z",
  });
  requests.setUsage(served, { inputTokens: 500, outputTokens: 40, servedModel: "model-a" });
  requests.insert({
    runId: "r6" as RunId,
    attempt: 1,
    requestKind: "messages",
    model: "model-q",
    stream: true,
    ts: "2026-09-22T09:00:02.000Z",
  });
  // Uncertain attribution on a final.
  run("r7", "ws2", "bot-c", "succeeded", "2026-09-23T08:00:00.000Z");
  events.append({
    runId: "r7" as RunId,
    attempt: 1,
    kind: "log",
    payload: { source: "usage_session_baseline", model: "model-a", attributionUncertain: true },
  });
  final("r7", 1, "model-a", [7, 7, 0, 0], 0.000126);
  // Priced before any configured price took effect: no estimate (unestimated coverage).
  run("r8", "ws", "bot-a", "stopped", "2025-12-30T08:00:00.000Z");
  final("r8", 1, "model-x", [5, 5, 0, 0], null);
});

afterEach(() => db.close());

const QUERIES: CostQuery[] = [
  {},
  { model: "model-a" },
  { model: "model-y" },
  { model: "missing" },
  { from: "2026-09-23" },
  { to: "2026-09-22" },
  { workspaceId: "ws2" as WorkspaceId },
  { botId: "bot-a" as BotId },
  { from: "2027-01-01" },
];
const json = (value: unknown) => JSON.stringify(value);

describe("the SQL-grouped report equals the per-request computation (decision 13)", () => {
  it.each(QUERIES)("report %j", (query) => {
    const legacy = new LegacyCostQueryStore(db).report(T, query);
    const fresh = new CostQueryStore(db);
    expect(json(fresh.report(T, query))).toBe(json(legacy));
    // A second read uses the stored summaries and answers the same.
    expect(json(fresh.report(T, query))).toBe(json(legacy));
    expect(json(fresh.summary(T, query))).toBe(
      json(new LegacyCostQueryStore(db).summary(T, query)),
    );
  });

  it.each(QUERIES)("row pages %j", (query) => {
    const legacy = new LegacyCostQueryStore(db);
    const fresh = new CostQueryStore(db);
    let after: [string, string, string, string] | undefined;
    for (let page = 0; page < 6; page += 1) {
      const a = legacy.rowPage(T, query, 2, after);
      const b = fresh.rowPage(T, query, 2, after);
      expect(json(b)).toBe(json(a));
      const last = b.rows.slice(0, 2).at(-1);
      if (!last || b.rows.length <= 2) break;
      after = [last.day, last.botName, last.botId, last.model];
    }
  });

  const dims: CostRankingDimension[] = ["model", "bot", "workspace"];
  const metrics: CostRankingMetric[] = ["money", "usage"];
  for (const by of dims)
    for (const metric of metrics)
      it(`ranking by ${by}, ${metric}`, () => {
        for (const query of QUERIES) {
          const a = new LegacyCostQueryStore(db).ranking(T, query, by, metric, 0, 100);
          const b = new CostQueryStore(db).ranking(T, query, by, metric, 0, 100);
          expect(json(b), json(query)).toBe(json(a));
          const pageA = new LegacyCostQueryStore(db).ranking(T, query, by, metric, 1, 1);
          const pageB = new CostQueryStore(db).ranking(T, query, by, metric, 1, 1);
          expect(json(pageB)).toBe(json(pageA));
        }
      });

  it("covers what the fixtures are meant to cover", () => {
    const report = new CostQueryStore(db).report(T);
    expect(report.totals.estimatedUsageCount).toBeGreaterThan(0);
    expect(report.totals.unestimatedUsageCount).toBeGreaterThan(0);
    expect(report.totals.attributionUncertain).toBe(true);
    expect(report.totals.usageCoverage).toBe("partial");
    // The in-flight run's two observed turns are lower bounds, not unpriced usage.
    const inFlight = report.rows.find((row) => row.model === "model-y");
    expect(inFlight).toMatchObject({ usageCount: 1, unpricedUsageCount: 0 });
  });
});

const stored = (runId: string) =>
  (
    db.prepare("SELECT count(*) AS n FROM run_usage_summaries WHERE run_id = ?").get(runId) as {
      n: number;
    }
  ).n;

describe("stored once, invalidated by its inputs (decisions 11 and 12)", () => {
  it("stores a per-model summary that matches the receipt", () => {
    refreshRunUsageSummary(db, "r3" as RunId);
    expect(new RunUsageSummaryStore(db).get("r3" as RunId)).toEqual({
      runId: "r3",
      coverage: "complete",
      models: [
        expect.objectContaining({
          model: "model-a",
          usageCount: 1,
          inputTokens: 40,
          pricedUsageCount: 1,
          knownCostUsd: 1,
          estimatedCostUsd: null,
          attributionUncertain: false,
        }),
        expect.objectContaining({ model: "model-b", knownCostUsd: 0.0015 }),
      ],
    });
  });

  it("the first report backfills every run, a second computes nothing", () => {
    expect(stored("r1")).toBe(0);
    new CostQueryStore(db).report(T);
    const all = db.prepare("SELECT run_id, computed_at FROM run_usage_summaries ORDER BY run_id");
    const first = all.all();
    expect(first.map((r) => (r as { run_id: string }).run_id)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
      "r8",
    ]);
    new CostQueryStore(db).report(T);
    expect(all.all()).toEqual(first);
  });

  it("a final usage row, a model request, a usage event and a resume each delete it", () => {
    const store = new RunUsageSummaryStore(db);
    store.refresh(["r1", "r4", "r6", "r7"] as RunId[]);
    final("r1", 3, "model-a", [1, 1, 0, 0], 0.5);
    expect(stored("r1")).toBe(0);
    turnUsage("r4", 3, "model-y", 200);
    expect(stored("r4")).toBe(0);
    requests.insert({
      runId: "r6" as RunId,
      attempt: 1,
      requestKind: "messages",
      model: "model-a",
      stream: false,
      ts: "2026-09-22T09:00:03.000Z",
    });
    expect(stored("r6")).toBe(0);
    db.prepare("UPDATE runs SET attempt = 2 WHERE id = 'r7'").run();
    expect(stored("r7")).toBe(0);
    // An unrelated event or a status change leaves a summary alone.
    store.refresh(["r1"] as RunId[]);
    events.append({ runId: "r1" as RunId, kind: "log", payload: { source: "budget" } });
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = 'r1'").run();
    expect(stored("r1")).toBe(1);
    // The next reader recomputes what was deleted, with the new usage.
    const report = new CostQueryStore(db).report(T, { botId: "bot-a" as BotId });
    expect(json(report)).toBe(
      json(new LegacyCostQueryStore(db).report(T, { botId: "bot-a" as BotId })),
    );
  });
});

describe("history is not re-priced (decision 14)", () => {
  it("a price edit leaves stored summaries alone; new usage on a run prices it afresh", () => {
    const costs = new CostQueryStore(db);
    const before = costs.report(T, { workspaceId: "ws" as WorkspaceId }).totals;
    // A new model price would change the average estimate of every unpriced row.
    prices.upsert({
      model: "model-z",
      inputPerM: 100,
      outputPerM: 100,
      cacheReadPerM: 100,
      cacheCreatePerM: 100,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    const after = costs.report(T, { workspaceId: "ws" as WorkspaceId }).totals;
    expect(after).toEqual(before);
    const live = new LegacyCostQueryStore(db).report(T, {
      workspaceId: "ws" as WorkspaceId,
    }).totals;
    expect(live.estimatedCostUsd).not.toBe(before.estimatedCostUsd);
    // r2's own usage changes: only r2 is priced again, at the edited table.
    final("r2", 2, "model-x", [1, 0, 0, 0], null);
    const r2 = costs.report(T, { from: "2026-09-23", botId: "bot-a" as BotId });
    expect(json(r2)).toBe(
      json(
        new LegacyCostQueryStore(db).report(T, {
          from: "2026-09-23",
          botId: "bot-a" as BotId,
        }),
      ),
    );
  });
});
