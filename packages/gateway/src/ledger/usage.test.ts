// T0: the usage store on a bare in-memory database. One row per (run, attempt, model);
// `list` reports the run, which is every attempt added up (ADR-0002 item 5).

import type { RunId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { EventStore } from "./events.js";
import { PriceStore } from "./prices.js";
import { UsageStore } from "./usage.js";

const MODEL = "test-model-default";
const RUN = "run-usage-1" as RunId;

function counts(model: string, inputTokens: number) {
  return {
    model,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  };
}

let db: GatewayDb;
let usage: UsageStore;
let prices: PriceStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('w', 'tnt_default', 'w', 'docker', 'ready', 't')",
  ).run();
  db.prepare(
    "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('b', 'w', 'b', 'r', 't')",
  ).run();
  db.prepare(
    "INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at) VALUES ('w', ?, 'b', 'interactive', 'running', 'thread_message', 'm', 't')",
  ).run(RUN);
  prices = new PriceStore(db);
  usage = new UsageStore(db, prices, new EventStore(db));
});

describe("run_usage is keyed on (run, attempt, model)", () => {
  it("keeps one row per attempt and sums the counts across them", () => {
    usage.record(RUN, 1, [counts(MODEL, 100)], "2026-09-22T10:00:00.000Z");
    usage.record(RUN, 2, [counts(MODEL, 60)], "2026-09-22T10:00:00.000Z");

    expect(usage.listByAttempt(RUN).map((r) => [r.attempt, r.inputTokens])).toEqual([
      [1, 100],
      [2, 60],
    ]);
    expect(usage.list(RUN)).toHaveLength(1);
    expect(usage.list(RUN)[0]?.inputTokens).toBe(160);
  });

  it("re-reporting the same attempt corrects that attempt only", () => {
    usage.record(RUN, 1, [counts(MODEL, 100)], "2026-09-22T10:00:00.000Z");
    usage.record(RUN, 2, [counts(MODEL, 60)], "2026-09-22T10:00:00.000Z");
    usage.record(RUN, 2, [counts(MODEL, 70)], "2026-09-22T10:00:00.000Z");
    expect(usage.listByAttempt(RUN)).toHaveLength(2);
    expect(usage.list(RUN)[0]?.inputTokens).toBe(170);
  });

  it("sums cost across attempts", () => {
    prices.upsert({
      model: MODEL,
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: 0.3,
      cacheCreatePerM: 3.75,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    usage.record(RUN, 1, [counts(MODEL, 1_000_000)], "2026-09-22T10:00:00.000Z");
    usage.record(RUN, 2, [counts(MODEL, 500_000)], "2026-09-22T10:00:00.000Z");
    expect(usage.list(RUN)[0]?.costUsd).toBe(4.5);
  });

  it("keeps costUsd null only when no attempt could be priced", () => {
    usage.record(RUN, 1, [counts(MODEL, 100)], "2026-09-22T10:00:00.000Z");
    usage.record(RUN, 2, [counts(MODEL, 50)], "2026-09-22T10:00:00.000Z");
    expect(usage.list(RUN)[0]?.costUsd).toBeNull();

    // A price that only arrives for the second attempt still contributes what it can price.
    prices.upsert({
      model: MODEL,
      inputPerM: 2,
      outputPerM: 0,
      cacheReadPerM: 0,
      cacheCreatePerM: 0,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    usage.record(RUN, 3, [counts(MODEL, 1_000_000)], "2026-09-22T10:00:00.000Z");
    expect(usage.list(RUN)[0]?.costUsd).toBe(2);
    expect(usage.list(RUN)[0]?.inputTokens).toBe(1_000_150);
  });

  it("reports one entry per model", () => {
    usage.record(RUN, 1, [counts(MODEL, 10), counts("cheap", 5)], "2026-09-22T10:00:00.000Z");
    usage.record(RUN, 2, [counts("cheap", 7)], "2026-09-22T10:00:00.000Z");
    expect(usage.list(RUN).map((u) => [u.model, u.inputTokens])).toEqual([
      [MODEL, 10],
      ["cheap", 12],
    ]);
  });

  it("counts only new tokens when a threadless cron continuation reports cumulative usage", () => {
    db.prepare("UPDATE runs SET trigger_kind = 'cron', thread_id = NULL WHERE id = ?").run(RUN);
    usage.record(RUN, 1, [counts(MODEL, 100)], "2026-09-22T10:00:00.000Z");
    usage.record(RUN, 2, [counts(MODEL, 160)], "2026-09-22T10:00:00.000Z");
    expect(usage.listByAttempt(RUN).map((r) => r.inputTokens)).toEqual([100, 60]);

    usage.record(RUN, 2, [counts(MODEL, 170)], "2026-09-22T10:00:00.000Z");
    expect(usage.listByAttempt(RUN).map((r) => r.inputTokens)).toEqual([100, 70]);
    expect(usage.list(RUN)[0]?.inputTokens).toBe(170);
  });
});
