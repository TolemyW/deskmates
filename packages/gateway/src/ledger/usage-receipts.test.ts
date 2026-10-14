import { createHash } from "node:crypto";
import type { RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { CostQueryStore } from "./costs.js";
import { EventStore } from "./events.js";
import { ModelRequestStore } from "./model-requests.js";
import { PriceStore } from "./prices.js";
import { combineReceipts, usageReceipts } from "./usage-receipts.js";
import { UsageStore } from "./usage.js";
const runId = "r" as RunId;
let db: GatewayDb;
let events: EventStore;
let requests: ModelRequestStore;
let usage: UsageStore;
const counts = (n: number) => ({
  model: "served",
  inputTokens: n,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
});
beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id,name,sandbox_provider,status,created_at) VALUES ('w', 'tnt_default','w','docker','ready','t')",
  ).run();
  db.prepare(
    "INSERT INTO bots (id,workspace_id,name,role,created_at) VALUES ('b','w','b','r','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (workspace_id, id,bot_id,lane,status,trigger_kind,trigger_ref,created_at,started_at) VALUES ('w', 'r','b','interactive','running','cron','m','2026-10-12','2026-10-12')",
  ).run();
  events = new EventStore(db);
  requests = new ModelRequestStore(db);
  usage = new UsageStore(db, new PriceStore(db), events);
});
afterEach(() => db.close());
function turn(turn: number, inputTokens: number, attempt = 1) {
  events.append({
    runId,
    kind: "turn_usage",
    attempt,
    seq: turn,
    payload: { ...counts(inputTokens), turn },
  });
}
describe("partial measured usage", () => {
  it.each(["cancelled", "failed", "running"])(
    "retains observed turns for %s without a final and deduplicates delivery",
    (status) => {
      turn(1, 100);
      turn(2, 200);
      turn(2, 200);
      // A duplicate response under another delivery sequence also cannot double count.
      events.append({ runId, kind: "turn_usage", seq: 3, payload: { ...counts(200), turn: 2 } });
      db.prepare("UPDATE runs SET status=? WHERE id='r'").run(status);
      const receipt = usageReceipts(db, runId);
      expect(receipt.coverage).toBe("partial");
      expect(combineReceipts(receipt.rows)).toMatchObject([
        { inputTokens: 300, outputTokens: 4, costUsd: null, coverage: "partial" },
      ]);
    },
  );
  it("preserves in-flight request measurements and unknown tail, without summing SDK duplicates", () => {
    turn(1, 100);
    const first = requests.insert({
      runId,
      attempt: 1,
      requestKind: "messages",
      model: "requested",
      stream: true,
      ts: "t",
    });
    requests.setUsage(first, { inputTokens: 100, servedModel: "served" });
    // Repeated callback replaces the same physical request, never creates another charge.
    requests.setUsage(first, { inputTokens: 100, servedModel: "served" });
    requests.insert({
      runId,
      attempt: 1,
      requestKind: "messages",
      model: "requested",
      stream: true,
      ts: "t",
    });
    const receipt = usageReceipts(db, runId);
    expect(receipt.coverage).toBe("partial");
    expect(receipt.rows).toMatchObject([
      { inputTokens: 100, outputTokens: 2, servedModel: "served", requestedModels: ["requested"] },
      { inputTokens: null, outputTokens: null, servedModel: null },
    ]);
  });
  it("counts distinct retry requests once; never prices an inferred served model", () => {
    for (let i = 0; i < 2; i++) {
      const id = requests.insert({
        runId,
        attempt: 1,
        requestKind: "messages",
        model: "served",
        stream: true,
        ts: "t",
      });
      requests.setUsage(id, { inputTokens: 20 });
    }
    expect(usageReceipts(db, runId).rows).toMatchObject([
      { inputTokens: 40, costUsd: null, servedModel: null },
    ]);
  });
  it("a queued cancellation is distinct from started unknown and a refused request", () => {
    db.prepare("UPDATE runs SET status='cancelled', started_at=NULL WHERE id='r'").run();
    requests.insert({
      runId,
      attempt: 1,
      requestKind: "messages",
      model: "m",
      stream: false,
      ts: "t",
      refusal: "model_not_selected",
    });
    expect(usageReceipts(db, runId)).toEqual({ rows: [], coverage: "not_started" });
    db.prepare("UPDATE runs SET started_at='t' WHERE id='r'").run();
    expect(usageReceipts(db, runId)).toEqual({ rows: [], coverage: "unknown" });
  });
  it("replaces partial attempts with later cumulative final and repeated final does not double count", () => {
    events.append({
      runId,
      attempt: 1,
      kind: "log",
      payload: {
        source: "sdk",
        usageSessionFingerprint: createHash("sha256").update("session").digest("hex"),
      },
    });
    events.append({
      runId,
      attempt: 2,
      kind: "log",
      payload: {
        source: "sdk",
        usageSessionFingerprint: createHash("sha256").update("session").digest("hex"),
      },
    });
    turn(1, 100);
    turn(1, 60, 2);
    expect(combineReceipts(usageReceipts(db, runId).rows)[0]?.inputTokens).toBe(160);
    db.prepare("UPDATE runs SET attempt=2 WHERE id='r'").run();
    usage.record(
      runId,
      2,
      [{ ...counts(170), outputTokens: 4 }],
      "2026-10-12",
      undefined,
      "session",
    );
    db.prepare("UPDATE runs SET attempt=2 WHERE id='r'").run();
    usage.record(
      runId,
      2,
      [{ ...counts(170), outputTokens: 4 }],
      "2026-10-12",
      undefined,
      "session",
    );
    expect(usageReceipts(db, runId).coverage).toBe("complete");
    expect(combineReceipts(usageReceipts(db, runId).rows)[0]?.inputTokens).toBe(170);
    events.append({
      runId,
      attempt: 3,
      kind: "log",
      payload: {
        source: "sdk",
        usageSessionFingerprint: createHash("sha256").update("session").digest("hex"),
      },
    });
    db.prepare("UPDATE runs SET attempt=3 WHERE id='r'").run();
    turn(1, 25, 3);
    expect(combineReceipts(usageReceipts(db, runId).rows)[0]?.inputTokens).toBe(195);
    usage.record(
      runId,
      3,
      [{ ...counts(200), outputTokens: 6 }],
      "2026-10-12",
      undefined,
      "session",
    );
    expect(combineReceipts(usageReceipts(db, runId).rows)[0]?.inputTokens).toBe(200);
  });
  it("exposes partial cost and isolates tenant accounting", () => {
    turn(1, 100);
    const costs = new CostQueryStore(db);
    expect(costs.report("tnt_default").totals).toMatchObject({
      inputTokens: 100,
      usageCoverage: "partial",
      knownCostUsd: null,
    });
    expect(costs.report("other-tenant").rows).toEqual([]);
    expect(costs.report("other-tenant").totals.runCount).toBe(0);
  });
  it("retains turns when a forwarded request has no response measurements", () => {
    turn(1, 100);
    turn(2, 200);
    requests.insert({
      runId,
      attempt: 1,
      requestKind: "messages",
      model: "served",
      stream: true,
      ts: "t",
    });
    expect(usageReceipts(db, runId).rows).toMatchObject([
      { inputTokens: 300, outputTokens: 4, coverage: "partial" },
    ]);
  });
  it("does not cover an older partial attempt with a fresh session final", () => {
    events.append({
      runId,
      attempt: 1,
      kind: "log",
      payload: {
        source: "sdk",
        usageSessionFingerprint: createHash("sha256").update("old").digest("hex"),
      },
    });
    turn(1, 100);
    usage.record(runId, 2, [counts(60)], "2026-10-12", undefined, "new");
    expect(combineReceipts(usageReceipts(db, runId).rows)[0]?.inputTokens).toBe(160);
    expect(usageReceipts(db, runId).coverage).toBe("partial");
  });
  it("keeps unknown session overlap as a lower bound instead of adding potentially cumulative final", () => {
    turn(1, 100);
    db.prepare("UPDATE runs SET attempt=2 WHERE id='r'").run();
    usage.record(runId, 2, [{ ...counts(170), outputTokens: 4 }], "2026-10-12");
    expect(combineReceipts(usageReceipts(db, runId).rows)[0]?.inputTokens).toBe(170);
    expect(usageReceipts(db, runId).coverage).toBe("partial");
  });
  it.each([true, false])(
    "allocates prior interrupted run measurements once across cumulative session finals (baseline=%s)",
    (hasBaseline) => {
      db.prepare(
        "INSERT INTO threads(id,workspace_id,kind,channel,title,turn_budget,status,created_at,updated_at) VALUES ('thread','w','chat','web','t',8,'active','t','t')",
      ).run();
      const session = {
        botId: "b" as import("@deskmates/contracts").BotId,
        threadId: "thread" as import("@deskmates/contracts").ThreadId,
        sdkSessionId: "session",
      };
      if (hasBaseline) usage.record(runId, 1, [counts(100)], "2026-10-12", session);
      db.prepare("UPDATE session_usage SET updated_at='2026-10-12T00:00:00Z'").run();
      db.prepare(
        "INSERT INTO runs(workspace_id, id,bot_id,thread_id,lane,status,trigger_kind,trigger_ref,created_at,started_at,config_json) VALUES ('w', 'partial','b','thread','interactive','cancelled','thread_message','x','2026-10-12T01:00:00Z','2026-10-12T01:00:00Z',?)",
      ).run(
        JSON.stringify({
          usageSessionFingerprint: createHash("sha256").update("session").digest("hex"),
        }),
      );
      events.append({
        runId: "partial" as RunId,
        kind: "turn_usage",
        payload: { ...counts(40), turn: 1, outputTokens: null },
      });
      db.prepare(
        "INSERT INTO runs(workspace_id, id,bot_id,thread_id,lane,status,trigger_kind,trigger_ref,created_at,started_at) VALUES ('w', 'next','b','thread','interactive','running','thread_message','x','2026-10-12T02:00:00Z','2026-10-12T02:00:00Z')",
      ).run();
      usage.record("next" as RunId, 1, [counts(180)], "2026-10-12", session);
      usage.record("next" as RunId, 1, [counts(180)], "2026-10-12", session);
      expect(usage.list("next" as RunId)[0]?.inputTokens).toBe(hasBaseline ? 40 : 140);
      const next = usageReceipts(db, "next" as RunId);
      expect(next.coverage).toBe("partial");
      expect(next.rows[0]).toMatchObject({ coverage: "partial", attributionUncertain: true });
      expect(new CostQueryStore(db).report("tnt_default").totals).toMatchObject({
        inputTokens: 180,
        attributionUncertain: true,
      });
    },
  );
  it("keeps observed retry excess and other served models when final is smaller", () => {
    turn(1, 100);
    turn(2, 200);
    events.append({
      runId,
      kind: "turn_usage",
      payload: { ...counts(50), model: "other", turn: 3 },
    });
    usage.record(runId, 1, [counts(200)], "2026-10-12");
    const receipt = usageReceipts(db, runId);
    expect(receipt.coverage).toBe("partial");
    expect(combineReceipts(receipt.rows)).toMatchObject([
      { model: "served", inputTokens: 300, coverage: "partial" },
      { model: "other", inputTokens: 50 },
    ]);
  });
  it("merges a later measured update for the same turn instead of adding or losing it", () => {
    events.append({
      runId,
      kind: "turn_usage",
      seq: 1,
      payload: { ...counts(100), turn: 1, outputTokens: null },
    });
    events.append({
      runId,
      kind: "turn_usage",
      seq: 2,
      payload: { ...counts(100), turn: 1, outputTokens: 9 },
    });
    expect(usageReceipts(db, runId).rows).toMatchObject([{ inputTokens: 100, outputTokens: 9 }]);
  });
});

describe("review follow-ups", () => {
  function insertRun(id: string, status: string, startedAt: string | null): void {
    db.prepare(
      "INSERT INTO runs (workspace_id, id,bot_id,lane,status,trigger_kind,trigger_ref,created_at,started_at) VALUES ('w', ?,'b','interactive',?,'cron','m','2026-10-12',?)",
    ).run(id, status, startedAt);
  }
  function final(id: string, input: number, cost: number | null): void {
    db.prepare(
      "INSERT INTO run_usage (run_id,attempt,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,cost_usd) VALUES (?,1,'served',?,1,0,0,?)",
    ).run(id, input, cost);
  }

  it("runs that never started are not_started and leave a priced report complete", () => {
    db.prepare("UPDATE runs SET status='succeeded' WHERE id='r'").run();
    final("r", 10, 0.5);
    insertRun("queued", "queued", null);
    insertRun("failed-early", "failed", null);
    expect(usageReceipts(db, "queued" as RunId).coverage).toBe("not_started");
    expect(usageReceipts(db, "failed-early" as RunId).coverage).toBe("not_started");
    const report = new CostQueryStore(db).report("tnt_default");
    expect(report.totals).toMatchObject({
      runCount: 1,
      usageCoverage: "complete",
      costStatus: "priced",
    });
    expect(report.rows.reduce((n, row) => n + row.runCount, 0)).toBe(report.totals.runCount);
  });

  it("an empty report has no usage coverage", () => {
    expect(new CostQueryStore(db).report("other-tenant").totals.usageCoverage).toBeUndefined();
  });

  it("combines coverage by precedence, not by the last row", () => {
    const measured = {
      runId,
      attempt: 1,
      model: "m",
      inputTokens: 10,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      costUsd: null,
      coverage: "partial" as const,
    };
    const unknown = {
      ...measured,
      attempt: 2,
      inputTokens: null,
      coverage: "unknown" as const,
    };
    expect(combineReceipts([measured, unknown])[0]?.coverage).toBe("partial");
    expect(combineReceipts([unknown, measured])[0]?.coverage).toBe("partial");
    const { coverage: _c, ...complete } = { ...measured, inputTokens: 5 };
    expect(combineReceipts([complete, unknown])[0]?.coverage).toBe("partial");
    expect(combineReceipts([complete, { ...complete, attempt: 2 }])[0]?.coverage).toBeUndefined();
  });

  it("does not subtract another model's SDK observations from a proxy row without a served model", () => {
    const id = requests.insert({
      runId,
      attempt: 1,
      requestKind: "messages",
      model: "requested",
      stream: true,
      ts: "t",
    });
    requests.setUsage(id, { inputTokens: 100 });
    events.append({
      runId,
      kind: "turn_usage",
      payload: { ...counts(50), model: "unrelated", turn: 1 },
    });
    const rows = combineReceipts(usageReceipts(db, runId).rows);
    expect(rows.find((r) => r.model === "requested")?.inputTokens).toBe(100);
    expect(rows.find((r) => r.model === "unrelated")?.inputTokens).toBe(50);
  });

  it("does not count an in-flight run's unpriced observations as unpriced usage", () => {
    const id = requests.insert({
      runId,
      attempt: 1,
      requestKind: "messages",
      model: "requested",
      stream: true,
      ts: "t",
    });
    requests.setUsage(id, { inputTokens: 100 });
    const costs = new CostQueryStore(db);
    expect(costs.report("tnt_default").totals).toMatchObject({
      inputTokens: 100,
      unpricedUsageCount: 0,
    });
    db.prepare("UPDATE runs SET status='failed' WHERE id='r'").run();
    expect(costs.report("tnt_default").totals.unpricedUsageCount).toBe(1);
  });

  it("aggregates a report with a bounded number of statements and the per-run receipts", () => {
    db.prepare("UPDATE runs SET status='succeeded' WHERE id='r'").run();
    final("r", 10, 0.25);
    const seed = (n: number) => {
      for (let i = 0; i < n; i++) {
        const id = `bulk-${n}-${i}`;
        insertRun(id, i % 2 ? "failed" : "succeeded", "2026-10-12");
        if (i % 2) {
          events.append({
            runId: id as RunId,
            kind: "turn_usage",
            payload: { ...counts(7 + i), turn: 1 },
          });
        } else final(id, 3 + i, i % 4 ? null : 0.125);
      }
    };
    const costs = new CostQueryStore(db);
    const prepares = (fn: () => void) => {
      const spy = vi.spyOn(db, "prepare");
      fn();
      const count = spy.mock.calls.length;
      spy.mockRestore();
      return count;
    };
    seed(2);
    const small = prepares(() => costs.report("tnt_default"));
    seed(20);
    const large = prepares(() => costs.report("tnt_default"));
    expect(large).toBe(small);
    // Reference: fold the single-run projection over every run.
    const ids = (db.prepare("SELECT id FROM runs").all() as { id: RunId }[]).map((r) => r.id);
    const rows = ids.flatMap((id) => usageReceipts(db, id).rows);
    const report = costs.report("tnt_default");
    expect(report.totals).toMatchObject({
      usageCount: rows.length,
      inputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      pricedUsageCount: rows.filter((r) => r.costUsd !== null).length,
      runCount: ids.filter((id) => usageReceipts(db, id).rows.length > 0).length,
    });
  });

  it("records a session final without scanning the run's whole event log", () => {
    db.prepare(
      "INSERT INTO threads(id,workspace_id,kind,channel,title,turn_budget,status,created_at,updated_at) VALUES ('thread','w','chat','web','t',8,'active','t','t')",
    ).run();
    const list = vi.spyOn(events, "list");
    usage.record(runId, 1, [counts(100)], "2026-10-12", {
      botId: "b" as import("@deskmates/contracts").BotId,
      threadId: "thread" as import("@deskmates/contracts").ThreadId,
      sdkSessionId: "session",
    });
    usage.record(runId, 2, [counts(100)], "2026-10-12", undefined, "session");
    expect(list).not.toHaveBeenCalled();
  });
});
