// T0: workspace execution limits (ADR-0005 amendment 5 decisions 37 to 39, ADR-0016 amendment 2
// decisions 13 to 15): validation, `off` needing the money backstop, precedence and the audit row.

import type { WorkspaceId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { BudgetStore } from "../budget/budget-store.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { WorkspaceLimitStore } from "./workspace-limits.js";

const WS = "ws" as WorkspaceId;
let db: GatewayDb;
let budget: BudgetStore;
let limits: WorkspaceLimitStore;

function audits() {
  return db
    .prepare(
      "SELECT before_json, after_json, actor FROM audit_events WHERE action = 'workspace.limits_set' ORDER BY seq",
    )
    .all() as { before_json: string; after_json: string; actor: string }[];
}

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws', 'tnt_default', 'Ops', 'docker', 'ready', '2026-09-01T00:00:00.000Z')",
  ).run();
  budget = new BudgetStore(db);
  limits = new WorkspaceLimitStore(db, budget, () => 80);
});

describe("defaults (decision 37, amendment 2 decision 14)", () => {
  it("stores nothing for a new workspace and resolves every value to today's default", () => {
    expect(limits.settings(WS)).toEqual({});
    expect(limits.effective(WS)).toEqual({
      continuationLimit: { value: 2, source: "default" },
      continuationWindowHours: { value: 24, source: "default" },
      maxTurns: { value: 80, source: "gateway" },
      relayCountMax: { value: 5, source: "default" },
      turnBudget: { value: 8, source: "default" },
    });
    expect(limits.threadCaps(WS, 8)).toEqual({
      turnBudget: { value: 8, source: "thread" },
      relayCountMax: { value: 5, source: "default" },
      relaxed: false,
    });
    expect(audits()).toHaveLength(0);
  });

  it("reads the Gateway's maxTurns on every call, not once when the store is built", () => {
    const config = { maxTurns: 50 };
    const live = new WorkspaceLimitStore(db, budget, () => config.maxTurns);
    config.maxTurns = 12;
    expect(live.effective(WS).maxTurns).toEqual({ value: 12, source: "gateway" });
    expect(live.runLimits(WS).maxTurns).toBe(12);
  });
});

describe("set (decisions 37 and 39)", () => {
  it("stores, clears and audits each change with before and after", () => {
    limits.set(WS, { turnBudget: 12, maxTurns: 30 }, "user:admin");
    expect(limits.settings(WS)).toEqual({ turnBudget: 12, maxTurns: 30 });
    expect(limits.threadCaps(WS, 8).turnBudget).toEqual({ value: 12, source: "workspace" });
    expect(limits.runLimits(WS)).toMatchObject({
      maxTurns: 30,
      limitSources: { maxTurns: "workspace", continuationLimit: "default" },
    });
    limits.set(WS, { turnBudget: null }, "user:admin");
    expect(limits.settings(WS)).toEqual({ maxTurns: 30 });
    const rows = audits();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]?.before_json ?? "")).toEqual({});
    expect(JSON.parse(rows[0]?.after_json ?? "")).toEqual({ turnBudget: 12, maxTurns: 30 });
    expect(JSON.parse(rows[1]?.after_json ?? "")).toEqual({ maxTurns: 30 });
    expect(rows[1]?.actor).toBe("user:admin");
  });

  it("writes no audit row when nothing changed", () => {
    limits.set(WS, { relayCountMax: 3 }, "user:admin");
    limits.set(WS, { relayCountMax: 3 }, "user:admin");
    expect(audits()).toHaveLength(1);
  });

  it.each([
    [{ turnBudget: 0 }],
    [{ turnBudget: 101 }],
    [{ relayCountMax: 51 }],
    [{ maxTurns: 2.5 }],
    [{ maxTurns: "12" }],
    [{ continuationLimit: -1 }],
    [{ continuationWindowHours: "off" }],
    [{ continuationWindowHours: 169 }],
    [{ somethingElse: 1 }],
  ])("refuses %j", (input) => {
    expect(() => limits.set(WS, input, "user:admin")).toThrow(/validation|must|unknown|cannot/);
    expect(limits.settings(WS)).toEqual({});
  });

  it("accepts a continuation limit of 0 (fail on the first exhaustion)", () => {
    limits.set(WS, { continuationLimit: 0 }, "user:admin");
    expect(limits.runLimits(WS).continuationLimit).toBe(0);
  });

  it("refuses off without a monetary limit and accepts it with one", () => {
    expect(() => limits.set(WS, { turnBudget: "off" }, "user:admin")).toThrow(/budget/);
    budget.setLimits(WS, { weeklyLimitUsd: 10 }, "user:admin");
    limits.set(
      WS,
      { turnBudget: "off", relayCountMax: "off", maxTurns: "off", continuationLimit: "off" },
      "user:admin",
    );
    expect(limits.threadCaps(WS, 8)).toEqual({
      turnBudget: { value: null, source: "workspace" },
      relayCountMax: { value: null, source: "workspace" },
      relaxed: true,
    });
    expect(limits.relayLimit(WS)).toBe(50);
    expect(limits.runLimits(WS)).toMatchObject({ maxTurns: null, continuationLimit: null });
  });

  it("resolves a stored off to the default once the last monetary limit is cleared", () => {
    budget.setLimits(WS, { cumulativeLimitUsd: 100 }, "user:admin");
    limits.set(WS, { turnBudget: "off", maxTurns: "off" }, "user:admin");
    budget.setLimits(WS, { cumulativeLimitUsd: null }, "user:admin");
    expect(limits.settings(WS)).toEqual({ turnBudget: "off", maxTurns: "off" });
    expect(limits.effective(WS).turnBudget).toEqual({ value: 8, source: "default_no_backstop" });
    expect(limits.effective(WS).maxTurns).toEqual({ value: 80, source: "default_no_backstop" });
    expect(limits.view(WS).budgetBackstop).toBe(false);
  });

  it("marks a cap above its default as relaxed", () => {
    limits.set(WS, { relayCountMax: 6 }, "user:admin");
    expect(limits.threadCaps(WS, 8).relaxed).toBe(true);
    limits.set(WS, { relayCountMax: 5, turnBudget: 4 }, "user:admin");
    expect(limits.threadCaps(WS, 8).relaxed).toBe(false);
  });
});
