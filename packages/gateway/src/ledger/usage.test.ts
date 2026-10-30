// T0: the usage store on a bare in-memory database. One row per (run, attempt, model);
// `list` reports the run, which is every attempt added up (ADR-0002 item 5).

import type { RunId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { EventStore } from "./events.js";
import { ModelRequestStore } from "./model-requests.js";
import { PriceStore } from "./prices.js";
import { usageReceipts } from "./usage-receipts.js";
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

describe("an attempt without the sidecar's usage is filed from its requests (ADR-0029 decision 8)", () => {
  const AT = "2026-10-17T10:00:00.000Z";
  let requests: ModelRequestStore;

  beforeEach(() => {
    requests = new ModelRequestStore(db);
  });

  function request(runId: RunId, attempt: number, input: number | null, output: number | null) {
    const id = requests.insert({
      runId,
      attempt,
      ts: AT,
      requestKind: "messages",
      model: MODEL,
      stream: true,
    });
    requests.setUsage(id, {
      ...(input === null ? {} : { inputTokens: input }),
      ...(output === null ? {} : { outputTokens: output }),
      servedModel: MODEL,
    });
  }

  it("sums the attempt's proxied requests into one proxy row per served model", () => {
    request(RUN, 1, 100, 10);
    request(RUN, 1, 200, 20);
    request(RUN, 2, 999, 99);
    usage.recordFromProxy(RUN, 1, AT);
    expect(usage.listByAttempt(RUN)).toMatchObject([
      { attempt: 1, source: "proxy", usageComplete: true, inputTokens: 300, outputTokens: 30 },
    ]);
    expect(usageReceipts(db, RUN).rows[0]).not.toHaveProperty("coverage", "partial");
  });

  it("marks the row incomplete, a lower bound, when a request reported no usage", () => {
    request(RUN, 1, 100, 10);
    request(RUN, 1, null, null);
    usage.recordFromProxy(RUN, 1, AT);
    expect(usage.listByAttempt(RUN)).toMatchObject([
      { source: "proxy", usageComplete: false, inputTokens: 100, outputTokens: 10 },
    ]);
    expect(usageReceipts(db, RUN).coverage).toBe("partial");
  });

  it("writes nothing for an attempt that made no request", () => {
    expect(usage.recordFromProxy(RUN, 1, AT)).toEqual([]);
    expect(usage.hasAttemptUsage(RUN, 1)).toBe(false);
  });

  it("sources the next attempt from its requests too, never from the SDK's cumulative total", () => {
    request(RUN, 1, 100, 10);
    usage.recordFromProxy(RUN, 1, AT);
    request(RUN, 2, 40, 4);
    // The resumed session's total includes the killed attempt it never reported.
    usage.record(RUN, 2, [{ ...counts(MODEL, 140), outputTokens: 14 }], AT);
    expect(usage.listByAttempt(RUN).map((r) => [r.attempt, r.source, r.inputTokens])).toEqual([
      [1, "proxy", 100],
      [2, "proxy", 40],
    ]);
    expect(usage.list(RUN)[0]?.inputTokens).toBe(140);
  });

  it("an SDK report of the same attempt replaces its proxy row", () => {
    request(RUN, 1, 100, 10);
    usage.recordFromProxy(RUN, 1, AT);
    usage.record(RUN, 1, [counts(MODEL, 105)], AT);
    expect(usage.listByAttempt(RUN)).toMatchObject([
      { attempt: 1, source: "sdk", usageComplete: true, inputTokens: 105 },
    ]);
  });

  it("in a thread session, the run after a killed one is proxy-sourced and the one after that measured again", () => {
    db.prepare(
      "INSERT INTO threads (id, workspace_id, kind, channel, title, turn_budget, status, created_at, updated_at) VALUES ('t', 'w', 'chat', 'web', 't', 0, 'active', 't', 't')",
    ).run();
    const insertRun = (id: string, startedAt: string) =>
      db
        .prepare(
          "INSERT INTO runs (workspace_id, id, bot_id, thread_id, lane, status, trigger_kind, trigger_ref, created_at, started_at) VALUES ('w', ?, 'b', 't', 'interactive', 'running', 'thread_message', 'm', ?, ?)",
        )
        .run(id, startedAt, startedAt);
    const session = (sdkSessionId: string) => ({
      botId: "b" as never,
      threadId: "t" as never,
      sdkSessionId,
    });
    // R0 reported 100 on the session; R1 was killed after 50 more; R2 resumes the session.
    insertRun("r0", "2026-10-17T09:00:00.000Z");
    usage.record("r0" as RunId, 1, [counts(MODEL, 100)], AT, session("s"));
    insertRun("r1", "2999-01-01T00:00:00.000Z");
    request("r1" as RunId, 1, 50, 5);
    usage.recordFromProxy("r1" as RunId, 1, AT);
    insertRun("r2", "2999-01-01T00:01:00.000Z");
    request("r2" as RunId, 1, 30, 3);
    usage.record("r2" as RunId, 1, [counts(MODEL, 180)], AT, session("s"));
    expect(usage.listByAttempt("r2" as RunId)).toMatchObject([
      { source: "proxy", inputTokens: 30 },
    ]);
    // R3 is measured from the total R2 reported, so R1's tokens are not counted again.
    insertRun("r3", "2999-01-01T00:02:00.000Z");
    db.prepare("UPDATE session_usage SET updated_at = '2999-01-01T00:01:30.000Z'").run();
    usage.record("r3" as RunId, 1, [counts(MODEL, 200)], AT, session("s"));
    expect(usage.listByAttempt("r3" as RunId)).toMatchObject([{ source: "sdk", inputTokens: 20 }]);
  });
});
