// T0: workspace budget limits, the charge ledger and verdicts (ADR-0032 decisions 1 to 4).

import type { RunId, WorkspaceId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { BudgetStore } from "./budget-store.js";

const WS = "ws" as WorkspaceId;
let db: GatewayDb;
let now: Date;
let budget: BudgetStore;

function seedRun(id: string, status = "succeeded"): RunId {
  db.prepare(
    `INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at, started_at)
     VALUES ('ws', ?, 'bot-a', 'interactive', ?, 'thread_message', ?, ?, ?)`,
  ).run(id, status, id, "2026-10-13T10:00:00.000Z", "2026-10-13T10:00:00.000Z");
  return id as RunId;
}

function seedUsage(
  runId: string,
  attempt: number,
  model: string,
  input: number,
  cost: number | null,
) {
  db.prepare(
    `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cache_read_tokens,
       cache_create_tokens, cost_usd) VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
  ).run(runId, attempt, model, input, cost);
}

function priceModel(model: string, inputPerM: number) {
  db.prepare(
    `INSERT INTO prices (model, input_per_m, output_per_m, cache_read_per_m, cache_create_per_m, effective_from)
     VALUES (?, ?, 0, 0, 0, '2020-01-01T00:00:00.000Z')`,
  ).run(model, inputPerM);
}

function audits(action: string) {
  return db
    .prepare(
      "SELECT before_json, after_json, actor FROM audit_events WHERE action = ? ORDER BY seq",
    )
    .all(action) as { before_json: string | null; after_json: string | null; actor: string }[];
}

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws', 'tnt_default', 'Ops', 'docker', 'ready', '2026-09-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('bot-a', 'ws', 'Alpha', '', '2026-09-01T00:00:00.000Z')",
  ).run();
  now = new Date("2026-10-13T12:00:00.000Z");
  budget = new BudgetStore(db, () => now);
});

describe("limits (decision 1)", () => {
  it("has no limit by default, so any spend is admitted", () => {
    expect(budget.limits(WS)).toEqual({ weeklyLimitUsd: null, cumulativeLimitUsd: null });
    const run = seedRun("run-1");
    seedUsage(run, 1, "m", 1, 1_000_000);
    budget.charge(run);
    expect(budget.verdict(WS).exhausted).toBeNull();
  });

  it("sets, keeps and clears limits with one audit row each, and rejects non-positive values", () => {
    budget.setLimits(WS, { weeklyLimitUsd: 5 }, "user:usr_a");
    budget.setLimits(WS, { cumulativeLimitUsd: 50 }, "user:usr_a");
    expect(budget.limits(WS)).toMatchObject({ weeklyLimitUsd: 5, cumulativeLimitUsd: 50 });
    budget.setLimits(WS, { weeklyLimitUsd: null }, "user:usr_b");
    expect(budget.limits(WS)).toMatchObject({ weeklyLimitUsd: null, cumulativeLimitUsd: 50 });
    const rows = audits("budget.set");
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[2]?.before_json ?? "{}")).toEqual({
      weeklyLimitUsd: 5,
      cumulativeLimitUsd: 50,
    });
    expect(JSON.parse(rows[2]?.after_json ?? "{}")).toEqual({
      weeklyLimitUsd: null,
      cumulativeLimitUsd: 50,
    });
    for (const bad of [0, -1, "5", Number.NaN])
      expect(() => budget.setLimits(WS, { weeklyLimitUsd: bad }, "user:usr_a")).toThrow(
        /positive number/,
      );
    expect(audits("budget.set")).toHaveLength(3);
  });
});

describe("charges (decisions 2 and 3)", () => {
  it("appends only the difference and nothing when nothing changed", () => {
    const run = seedRun("run-1");
    seedUsage(run, 1, "m", 100, 0.5);
    expect(budget.charge(run)).toBe(true);
    expect(budget.charge(run)).toBe(false);
    seedUsage(run, 2, "m", 100, 0.25);
    expect(budget.charge(run)).toBe(true);
    const charges = db
      .prepare("SELECT known_usd FROM budget_charges WHERE run_id = ? ORDER BY id")
      .all(run) as { known_usd: number }[];
    expect(charges.map((c) => c.known_usd)).toEqual([0.5, 0.25]);
    expect(budget.spend(WS).cumulative).toMatchObject({ knownUsd: 0.75, totalUsd: 0.75 });
  });

  it("charges unpriced usage as a separate estimate, and an empty price table as unestimated", () => {
    const run = seedRun("run-1");
    seedUsage(run, 1, "unpriced-model", 1_000_000, null);
    budget.charge(run);
    expect(budget.spend(WS).cumulative).toMatchObject({
      knownUsd: 0,
      estimatedUsd: 0,
      unestimatedUsageCount: 1,
    });
    // A price for another model makes an average exist: the later charge carries the estimate.
    priceModel("priced-a", 2);
    priceModel("priced-b", 4);
    budget.charge(run);
    expect(budget.spend(WS).cumulative).toMatchObject({
      knownUsd: 0,
      estimatedUsd: 3,
      totalUsd: 3,
      unestimatedUsageCount: 0,
    });
    const version = db
      .prepare("SELECT estimate_version FROM budget_charges WHERE estimated_usd > 0")
      .get() as { estimate_version: string };
    expect(version.estimate_version).toBe("avg-unit-price-v1");
  });

  it("files a charge in the week it was observed; the weekly total resets, the cumulative does not", () => {
    const run = seedRun("run-1", "running");
    now = new Date("2026-10-18T23:59:00.000Z");
    seedUsage(run, 1, "m", 1, 2);
    budget.charge(run);
    now = new Date("2026-10-19T00:00:00.000Z");
    expect(budget.spend(WS).week.totalUsd).toBe(0);
    expect(budget.spend(WS).cumulative.totalUsd).toBe(2);
    seedUsage(run, 2, "m", 1, 1);
    budget.charge(run);
    expect(budget.spend(WS).week.totalUsd).toBe(1);
    expect(budget.spend(WS).cumulative.totalUsd).toBe(3);
  });
});

describe("verdicts and parks (decisions 5 to 7)", () => {
  it("is exhausted at the limit, weekly first, and a continue is refused until a limit is raised", () => {
    const run = seedRun("run-1", "queued");
    seedUsage(run, 1, "m", 1, 5);
    budget.charge(run);
    budget.setLimits(WS, { weeklyLimitUsd: 5, cumulativeLimitUsd: 5 }, "user:usr_a");
    const verdict = budget.verdict(WS);
    expect(verdict).toMatchObject({ exhausted: "weekly", limitUsd: 5, spendUsd: 5 });
    const park = budget.park(run, 1, "admission", verdict);
    expect(park.created).toBe(true);
    expect(budget.park(run, 1, "admission", verdict)).toEqual({ id: park.id, created: false });
    expect(budget.parkedRunIds().has(run)).toBe(true);
    expect(() => budget.continueParked(WS, "user:usr_a")).toThrow(/still exhausted/);
    budget.setLimits(WS, { weeklyLimitUsd: 10 }, "user:usr_a");
    expect(budget.verdict(WS).exhausted).toBe("cumulative");
    // Raising alone resumes nothing: the park stays open.
    budget.setLimits(WS, { cumulativeLimitUsd: null }, "user:usr_a");
    expect(budget.parkedRunIds().has(run)).toBe(true);
    expect(budget.continueParked(WS, "user:usr_a")).toEqual([run]);
    expect(budget.parkedRunIds().has(run)).toBe(false);
    expect(audits("budget.continue")).toHaveLength(1);
  });

  it("ignores the open park of a run that has since ended", () => {
    const run = seedRun("run-1", "queued");
    budget.setLimits(WS, { weeklyLimitUsd: 1 }, "user:usr_a");
    seedUsage(run, 1, "m", 1, 1);
    budget.charge(run);
    budget.park(run, 1, "admission", budget.verdict(WS));
    db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(run);
    expect(budget.parkedRunIds().has(run)).toBe(false);
    expect(budget.parks(WS)).toEqual([]);
  });
});
