// T0: cost alert rules over the cost report's own windows (ADR-0018 decisions 1 and 3). The
// clock is injected so a window boundary is a fact of the test, not of the wall clock.

import {
  type BotId,
  type RunId,
  costAlertWindowKey,
  costAlertWindowRange,
} from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { CostAlertStore } from "./cost-alerts.js";
import { CostQueryStore } from "./costs.js";
import { EventStore } from "./events.js";

const T = "tnt_default";

const BOT = "bot_a" as BotId;
const OTHER = "bot_b" as BotId;

function seedBots(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws_1', 'tnt_default', 'ws', 'docker', 'ready', '2026-10-01T00:00:00.000Z')",
  ).run();
  for (const [id, name] of [
    [BOT, "alice"],
    [OTHER, "bob"],
  ]) {
    db.prepare(
      "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES (?, 'ws_1', ?, 'r', '2026-10-01T00:00:00.000Z')",
    ).run(id, name);
  }
}

let counter = 0;
/** A run created at `createdAt` with one usage row; `at(...)` is what the lifecycle passes. */
function usage(
  db: ReturnType<typeof openDatabase>,
  botId: BotId,
  createdAt: string,
  costUsd: number | null,
): RunId {
  const id = `run_${++counter}` as RunId;
  db.prepare(
    "INSERT INTO runs (workspace_id, id, bot_id, lane, trigger_kind, trigger_ref, status, created_at) VALUES ('ws_1', ?, ?, 'interactive', 'thread_message', 'm', 'succeeded', ?)",
  ).run(id, botId, createdAt);
  db.prepare(
    "INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd) VALUES (?, 1, 'model-a', 100, 50, 0, 0, ?)",
  ).run(id, costUsd);
  return id;
}

describe("window helpers", () => {
  it("keys and bounds UTC days and months", () => {
    const at = new Date("2026-10-02T23:59:59.000Z");
    expect(costAlertWindowKey("day", at)).toBe("2026-10-02");
    expect(costAlertWindowKey("month", at)).toBe("2026-10");
    expect(costAlertWindowRange("day", at)).toEqual({ from: "2026-10-02", to: "2026-10-02" });
    expect(costAlertWindowRange("month", at)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(costAlertWindowRange("month", new Date("2028-02-10T00:00:00.000Z"))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
});

const at = (iso: string): Date => new Date(iso);

describe("CostAlertStore", () => {
  let db: ReturnType<typeof openDatabase>;
  let store: CostAlertStore;
  let events: EventStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedBots(db);
    events = new EventStore(db);
    store = new CostAlertStore(db, new CostQueryStore(db), events);
  });

  it("validates the rule vocabulary", () => {
    expect(() =>
      store.createRule(T, { kind: "known_cost", window: "day", createdBy: "human:web" }),
    ).toThrow(/thresholdUsd/);
    expect(() =>
      store.createRule(T, { kind: "known_cost", window: "day", thresholdUsd: 0, createdBy: "x" }),
    ).toThrow(/thresholdUsd/);
    expect(() =>
      store.createRule(T, {
        kind: "unpriced_usage",
        window: "day",
        thresholdUsd: 1,
        createdBy: "x",
      }),
    ).toThrow(/no thresholdUsd/);
    expect(() =>
      store.createRule(T, {
        kind: "known_cost",
        // A value outside the vocabulary, on purpose.
        window: "week" as unknown as "day",
        thresholdUsd: 1,
        createdBy: "x",
      }),
    ).toThrow(/window/);
  });

  it("fires a known_cost rule at the threshold, once per window, and resets next day", () => {
    const rule = store.createRule(T, {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 1,
      createdBy: "human:web",
    });
    const r1 = usage(db, BOT, "2026-10-02T09:00:00.000Z", 0.4);
    expect(store.evaluate(r1, BOT, at("2026-10-02T09:00:00.000Z"))).toEqual([]);
    const r2 = usage(db, BOT, "2026-10-02T09:30:00.000Z", 0.6);
    const fired = store.evaluate(r2, BOT, at("2026-10-02T09:30:00.000Z"));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      ruleId: rule.id,
      kind: "known_cost",
      window: "day",
      windowKey: "2026-10-02",
      thresholdUsd: 1,
      runId: r2,
      totals: { knownCostUsd: 1, runCount: 2, usageCount: 2, unpricedUsageCount: 0 },
    });
    expect(fired[0]?.botId).toBeUndefined();
    // The crossing run carries the event; nothing else fires in the same window.
    const kinds = events.list(r2).map((e) => e.kind);
    expect(kinds).toEqual(["cost_alert"]);
    const r3 = usage(db, BOT, "2026-10-02T11:00:00.000Z", 5);
    expect(store.evaluate(r3, BOT, at("2026-10-02T11:00:00.000Z"))).toEqual([]);
    expect(store.listAlerts(T, "open")).toHaveLength(1);
    // Next UTC day: the window resets and the first crossing fires again.
    const r4 = usage(db, BOT, "2026-10-03T00:00:00.000Z", 2);
    expect(store.evaluate(r4, BOT, at("2026-10-03T00:00:00.000Z"))).toHaveLength(1);
    expect(store.listAlerts(T, "open").map((a) => a.windowKey)).toEqual([
      "2026-10-03",
      "2026-10-02",
    ]);
  });

  it("scopes a bot rule to that bot and a global rule to everyone", () => {
    store.createRule(T, {
      kind: "known_cost",
      window: "month",
      botId: BOT,
      thresholdUsd: 1,
      createdBy: "human:web",
    });
    const other = usage(db, OTHER, "2026-10-01T09:00:00.000Z", 3);
    expect(store.evaluate(other, OTHER, at("2026-10-01T09:00:00.000Z"))).toEqual([]);
    const mine = usage(db, BOT, "2026-10-02T09:00:00.000Z", 1.5);
    const fired = store.evaluate(mine, BOT, at("2026-10-02T09:00:00.000Z"));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      botId: BOT,
      windowKey: "2026-10",
      totals: { knownCostUsd: 1.5 },
    });
  });

  it("fires an unpriced_usage rule on the first unpriced row and keeps the unknown visible", () => {
    store.createRule(T, { kind: "unpriced_usage", window: "day", createdBy: "human:web" });
    const priced = usage(db, BOT, "2026-10-02T09:00:00.000Z", 0.2);
    expect(store.evaluate(priced, BOT, at("2026-10-02T09:00:00.000Z"))).toEqual([]);
    const unpriced = usage(db, BOT, "2026-10-02T09:10:00.000Z", null);
    const fired = store.evaluate(unpriced, BOT, at("2026-10-02T09:10:00.000Z"));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.totals).toMatchObject({
      knownCostUsd: 0.2,
      unpricedUsageCount: 1,
      pricedUsageCount: 1,
      costStatus: "partial",
    });
    expect(fired[0]?.thresholdUsd).toBeUndefined();
  });

  it("does not re-arm a fired window when the threshold changes, but a new rule does", () => {
    const rule = store.createRule(T, {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 1,
      createdBy: "human:web",
    });
    const r1 = usage(db, BOT, "2026-10-02T09:00:00.000Z", 2);
    expect(store.evaluate(r1, BOT, at("2026-10-02T09:00:00.000Z"))).toHaveLength(1);
    expect(store.deleteRule(T, rule.id, "human:web")).toBe(true);
    // The alert survives the rule and still names it.
    expect(store.listAlerts(T, "all").map((a) => a.ruleId)).toEqual([rule.id]);
    store.createRule(T, {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 1.5,
      createdBy: "human:web",
    });
    const r2 = usage(db, BOT, "2026-10-02T09:30:00.000Z", 0.1);
    expect(store.evaluate(r2, BOT, at("2026-10-02T09:30:00.000Z"))).toHaveLength(1);
  });

  it("files a run that ends after midnight under the day and month it was created in", () => {
    store.createRule(T, {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 1,
      createdBy: "human:web",
    });
    store.createRule(T, {
      kind: "known_cost",
      window: "month",
      thresholdUsd: 1,
      createdBy: "human:web",
    });
    // Created 2026-09-30 23:50 UTC, ended 2026-10-01 00:20 UTC, cost $2: the cost report puts the
    // $2 on 2026-09-30 and September, so that is where the alerts must fire.
    const run = usage(db, BOT, "2026-09-30T23:50:00.000Z", 2);
    const fired = store.evaluate(run, BOT, at("2026-09-30T23:50:00.000Z"));
    expect(fired.map((a) => a.windowKey).sort()).toEqual(["2026-09", "2026-09-30"]);
    expect(fired.every((a) => a.totals.knownCostUsd === 2)).toBe(true);
  });

  it("acknowledges once and leaves the open list", () => {
    store.createRule(T, {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 1,
      createdBy: "human:web",
    });
    const r1 = usage(db, BOT, "2026-10-02T09:00:00.000Z", 2);
    const [alert] = store.evaluate(r1, BOT, at("2026-10-02T09:00:00.000Z"));
    if (!alert) throw new Error("expected an alert");
    const acked = store.acknowledge(T, alert.id, "human:ops");
    expect(acked.acknowledgedBy).toBe("human:ops");
    expect(acked.acknowledgedAt).toBeDefined();
    expect(store.acknowledge(T, alert.id, "human:other").acknowledgedBy).toBe("human:ops");
    expect(store.listAlerts(T, "open")).toEqual([]);
    expect(store.listAlerts(T, "acknowledged")).toHaveLength(1);
    expect(() => store.acknowledge(T, "cal_missing", "human:ops")).toThrow(/not found/);
  });
});
