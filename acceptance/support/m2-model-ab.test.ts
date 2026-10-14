import { describe, expect, it } from "vitest";
import {
  type AbRow,
  abSampleSizeCaveat,
  formatAbSummary,
  readAbConfig,
  runTokens,
  sumTokens,
  summarizeAbRows,
} from "./m2-model-ab.mjs";

const usage = (input: number, output: number, cacheRead: number, cacheCreate: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreateTokens: cacheCreate,
});
const UNKNOWN = {
  inputTokens: "unknown",
  outputTokens: "unknown",
  cacheReadTokens: "unknown",
  cacheCreateTokens: "unknown",
} as const;

describe("readAbConfig", () => {
  it("reads both model ids and the round count", () => {
    expect(
      readAbConfig({ M2_AB_MODEL_A: " glm-x ", M2_AB_MODEL_B: "deepseek-y", M2_AB_ROUNDS: "7" }),
    ).toEqual({ modelA: "glm-x", modelB: "deepseek-y", rounds: 7 });
  });

  it("defaults to five rounds", () => {
    expect(readAbConfig({ M2_AB_MODEL_A: "a", M2_AB_MODEL_B: "b" }).rounds).toBe(5);
  });

  it("fails fast when either model id is unset and never falls back to DEFAULT_MODEL", () => {
    for (const env of [
      { M2_AB_MODEL_B: "b", DEFAULT_MODEL: "d" },
      { M2_AB_MODEL_A: "a", M2_AB_MODEL_B: "  ", DEFAULT_MODEL: "d" },
      { DEFAULT_MODEL: "d" },
    ]) {
      expect(() => readAbConfig(env)).toThrow(/M2_AB_MODEL_A and M2_AB_MODEL_B.*DEFAULT_MODEL/s);
    }
    expect(() => readAbConfig({ M2_AB_MODEL_B: "b" })).toThrow(/unset: M2_AB_MODEL_A\b/);
  });

  it("rejects a round count that is not a positive integer within the cap", () => {
    for (const rounds of ["0", "-1", "2.5", "x", "41"]) {
      expect(() =>
        readAbConfig({ M2_AB_MODEL_A: "a", M2_AB_MODEL_B: "b", M2_AB_ROUNDS: rounds }),
      ).toThrow(/M2_AB_ROUNDS/);
    }
  });
});

describe("token accounting", () => {
  it("sums a run's usage rows across models", () => {
    expect(runTokens([usage(10, 2, 100, 5), usage(1, 1, 0, 0)])).toEqual(usage(11, 3, 100, 5));
  });

  it("records a run without usage rows as unknown, never zero", () => {
    expect(runTokens([])).toEqual(UNKNOWN);
  });

  it("keeps unknown through a sum", () => {
    expect(sumTokens([usage(1, 2, 3, 4), UNKNOWN])).toEqual(UNKNOWN);
    expect(sumTokens([usage(1, 2, 3, 4), usage(1, 1, 1, 1)])).toEqual(usage(2, 3, 4, 5));
    expect(sumTokens([])).toEqual(usage(0, 0, 0, 0));
  });
});

function row(
  arm: "A" | "B",
  round: number,
  passed: boolean,
  wallMs: number,
  runs: AbRow["runs"],
): AbRow {
  return {
    arm,
    model: arm === "A" ? "model-a" : "model-b",
    round,
    label: `chief${round}`,
    passed,
    wallMs,
    assessment: undefined,
    tokens: sumTokens(runs.map((run) => run.tokens)),
    runs,
  };
}

describe("summarizeAbRows", () => {
  const rows: AbRow[] = [
    row("A", 1, true, 30_000, [
      { id: "r1", bot: "chief", status: "succeeded", tokens: usage(10, 1, 0, 0) },
    ]),
    row("B", 1, true, 40_000, [
      { id: "r2", bot: "chief", status: "succeeded", tokens: usage(20, 2, 5, 0) },
    ]),
    row("A", 2, false, 4_000, [
      { id: "r3", bot: "chief", status: "silent", tokens: usage(5, 1, 0, 0) },
    ]),
    row("B", 2, true, 36_000, [
      { id: "r4", bot: "chief", status: "succeeded", tokens: usage(20, 2, 5, 0) },
      { id: "r5", bot: "analyst", status: "failed", tokens: UNKNOWN },
    ]),
    row("A", 3, true, 26_000, [
      { id: "r6", bot: "chief", status: "succeeded", tokens: usage(10, 1, 0, 0) },
    ]),
    row("B", 3, true, 31_000, [
      { id: "r7", bot: "chief", status: "succeeded", tokens: usage(20, 2, 5, 0) },
    ]),
  ];

  it("reports per-arm pass count, median and range of wallMs, and total tokens", () => {
    const summary = summarizeAbRows(rows, { A: "model-a", B: "model-b" }, 3);
    expect(summary.rounds).toBe(3);
    expect(summary.arms).toEqual([
      {
        arm: "A",
        model: "model-a",
        rows: 3,
        passed: 3 - 1,
        wallMs: { median: 26_000, min: 4_000, max: 30_000 },
        tokens: usage(25, 3, 0, 0),
        runsMissingUsage: 0,
      },
      {
        arm: "B",
        model: "model-b",
        rows: 3,
        passed: 3,
        wallMs: { median: 36_000, min: 31_000, max: 40_000 },
        tokens: UNKNOWN,
        runsMissingUsage: 1,
      },
    ]);
    expect(summary.caveat).toBe(abSampleSizeCaveat(3));
  });

  it("uses the mean of the middle pair for an even count and null for an arm with no rows", () => {
    const summary = summarizeAbRows(rows.slice(0, 4), { A: "model-a", B: "model-b" }, 2);
    expect(summary.arms[0]?.wallMs).toEqual({ median: 17_000, min: 4_000, max: 30_000 });
    const empty = summarizeAbRows([], { A: "model-a", B: "model-b" }, 2);
    expect(empty.arms[0]).toMatchObject({ rows: 0, passed: 0, wallMs: null });
  });
});

describe("sample-size caveat", () => {
  it("states what the round count can and cannot resolve", () => {
    // Wrapped for a terminal; the claims are read across line breaks.
    const text = abSampleSizeCaveat(5).replace(/\s+/g, " ");
    expect(text).toContain("5 rounds per arm");
    expect(text).toMatch(/10% failure rate from a 30% one/);
    expect(text).toMatch(/20\+ rounds per arm/);
    expect(text).toMatch(/cannot rank two models that both mostly work/);
  });

  it("is printed alongside the summary", () => {
    const summary = summarizeAbRows([], { A: "model-a", B: "model-b" }, 5);
    const printed = formatAbSummary(summary);
    expect(printed).toContain("A model-a: 0/0 passed");
    expect(printed).toContain(abSampleSizeCaveat(5));
  });
});
