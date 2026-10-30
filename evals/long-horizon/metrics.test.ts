import {
  type RunEvent,
  type RunId,
  type RunUsageReceipt,
  buildRunTimeline,
  timelineMark,
} from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { observeRun, totals, usageMetrics } from "./metrics.js";

const id = "run_metric" as RunId;
const at = "2026-10-19T00:00:00.000Z";
const row: RunUsageReceipt = {
  runId: id,
  model: "test",
  inputTokens: 20,
  outputTokens: 5,
  cacheReadTokens: 100,
  cacheCreateTokens: 7,
  costUsd: 0,
};
const events: RunEvent[] = [1, 2].map((attempt) => ({
  runId: id,
  seq: attempt,
  attempt,
  kind: "log",
  ts: at,
  payload: timelineMark("attempt_started", new Date(at)),
}));
function observation() {
  return observeRun({
    runId: id,
    status: "succeeded",
    attempt: 2,
    usage: [row],
    coverage: "complete",
    events,
    timeline: buildRunTimeline({
      runId: id,
      status: "succeeded",
      attempt: 2,
      createdAt: at,
      finishedAt: at,
      events,
    }),
  });
}

describe("long-horizon usage and attempt accounting", () => {
  it("retains all four token dimensions and both physical attempts", () => {
    const observed = observation();
    expect(observed.tokens).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreateTokens: 7,
    });
    expect(observed.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(totals([observed]).physicalAttempts).toBe(2);
  });
  it("counts cumulative logical run usage once even when collected after several phases", () => {
    const observed = observation();
    expect(totals([observed, observed])).toMatchObject({
      logicalRuns: 1,
      physicalAttempts: 2,
      tokens: { inputTokens: 20 },
    });
  });
  it("keeps a partial or absent receipt unknown instead of summing a lower bound", () => {
    expect(usageMetrics([row], "partial")).toMatchObject({
      costUsd: null,
      tokens: { inputTokens: null },
    });
    expect(usageMetrics([], "complete").tokens.inputTokens).toBeNull();
    expect(
      usageMetrics([{ ...row, cacheReadTokens: null }], "complete").tokens.cacheReadTokens,
    ).toBeNull();
    expect(usageMetrics([], "not_started")).toEqual({
      costUsd: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    });
  });
  it("does not infer a physical process from a never-started run row", () => {
    const observed = observeRun({
      runId: id,
      status: "cancelled",
      attempt: 1,
      usage: [],
      coverage: "not_started",
      events: [],
      timeline: buildRunTimeline({
        runId: id,
        status: "cancelled",
        attempt: 1,
        createdAt: at,
        finishedAt: at,
        events: [],
      }),
    });
    expect(totals([observed]).physicalAttempts).toBe(0);
  });
  it("does not report zero tokens for a posted run whose observer has not reached it", () => {
    expect(totals([], ["run_posted", "run_posted"])).toMatchObject({
      logicalRuns: 1,
      physicalAttempts: null,
      unknownUsageRuns: 1,
      costUsd: null,
      tokens: { inputTokens: null },
      unobservedRunIds: ["run_posted"],
    });
  });
  it("propagates any unknown usage and detects a missing ledger prefix", () => {
    const observed = observation();
    const unknown = {
      ...observed,
      runId: "run_unknown",
      coverage: "unknown" as const,
      tokens: usageMetrics([], "unknown").tokens,
      costUsd: null,
    };
    expect(totals([observed, unknown])).toMatchObject({
      unknownUsageRuns: 1,
      costUsd: null,
      tokens: { inputTokens: null },
    });
    const missing = observeRun({
      runId: id,
      status: "succeeded",
      attempt: 1,
      usage: [row],
      coverage: "complete",
      events: events.slice(1),
      timeline: buildRunTimeline({
        runId: id,
        status: "succeeded",
        attempt: 1,
        createdAt: at,
        events: [],
      }),
    });
    expect(missing.ledgerContiguous).toBe(false);
  });
});
