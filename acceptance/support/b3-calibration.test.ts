import { describe, expect, it } from "vitest";
import {
  type TicketArm,
  classifyInterference,
  completedTicketStatus,
  interferenceCalibration,
  rateInterval,
  rescoreRecordedTicketPair,
  ticketOracle,
  turnBudgetCalibration,
} from "./b3-calibration.js";

function arm(indices: number[]): TicketArm {
  return {
    indices,
    checks: [
      "runtime",
      "requested writes",
      "unchanged unrelated state",
      "distinct stable targets",
      ...indices.flatMap((_, index) => [
        `run ${index}: screenshot attribution`,
        `run ${index}: no own-tab lock wait`,
      ]),
      ...(indices.length === 2 ? ["runs overlap"] : []),
    ].map((name) => ({ name, passed: true })),
  };
}
const pair = (repetition = 1, id = "X02") => ({
  id,
  repetition,
  arms: [arm([0]), arm([1]), arm([0, 1])],
});

describe("B3 calibration integrity", () => {
  it("accepts explicit silence only as completed execution, preserving max-turn failures", () => {
    expect(completedTicketStatus("silent")).toBe(true);
    for (const status of ["failed", "cancelled", "running", "waiting_approval"])
      expect(completedTicketStatus(status)).toBe(false);
    const value = pair();
    for (const item of value.arms) {
      item.runs = item.indices.map(() => ({ status: "silent" }));
      item.waitErrors = [];
    }
    const oldRuntime = value.arms[0]?.checks?.find((check) => check.name === "runtime");
    if (oldRuntime) oldRuntime.passed = false;
    expect(classifyInterference(rescoreRecordedTicketPair(value))).toBe("clean");
    expect(oldRuntime?.passed).toBe(false);
    const failed = value.arms[2]?.runs?.[0];
    if (failed) failed.status = "failed";
    expect(classifyInterference(rescoreRecordedTicketPair(value))).toBe("interference");
  });
  it("keeps recovered tool errors diagnostic without masking a canonical state failure", () => {
    const value = arm([0]);
    value.checks?.push({ name: "run 0: tool errors and takeover", passed: false });
    expect(ticketOracle(value)).toBe(true);
    const write = value.checks?.find((check) => check.name === "requested writes");
    if (write) write.passed = false;
    expect(ticketOracle(value)).toBe(false);
  });
  it("never counts missing arms, failed solo controls or incomplete checks as a clean pair", () => {
    const value = pair();
    expect(classifyInterference(value)).toBe("clean");
    value.arms[0]?.checks?.pop();
    expect(classifyInterference(value)).toBe("unclassifiable");
    expect(classifyInterference({ id: "X03", arms: [] })).toBe("unclassifiable");
  });
  it("keeps failed solo runs and solo wait errors unclassifiable after re-scoring", () => {
    const failed = pair();
    for (const item of failed.arms) {
      item.runs = item.indices.map(() => ({ status: "succeeded" }));
      item.waitErrors = [];
    }
    const failedSolo = failed.arms[0]?.runs?.[0];
    if (failedSolo) failedSolo.status = "failed";
    expect(classifyInterference(rescoreRecordedTicketPair(failed))).toBe("unclassifiable");

    const waitError = pair();
    for (const item of waitError.arms) {
      item.runs = item.indices.map(() => ({ status: "succeeded" }));
      item.waitErrors = [];
    }
    waitError.arms[1]?.waitErrors?.push("timed out");
    expect(classifyInterference(rescoreRecordedTicketPair(waitError))).toBe("unclassifiable");
  });
  it("escalates one concurrent failure out of ten, requiring five samples per scenario", () => {
    const pairs = Array.from({ length: 5 }, (_, index) => [
      pair(index + 1, "X02"),
      pair(index + 1, "X03"),
    ]).flat();
    expect(interferenceCalibration(pairs).verdict).toBe("retain-lock-v1");
    const write = pairs[0]?.arms[2]?.checks?.find((check) => check.name === "requested writes");
    if (write) write.passed = false;
    expect(interferenceCalibration(pairs).verdict).toBe("new-lock-ADR-required");
    expect(interferenceCalibration(pairs.slice(1)).verdict).toBe("incomplete");
  });
  it("requires five distinct complete repetitions and excludes unknown scenarios", () => {
    const fourComplete = Array.from({ length: 4 }, (_, index) => [
      pair(index + 1, "X02"),
      pair(index + 1, "X03"),
    ]).flat();
    const duplicated = [
      ...fourComplete,
      pair(5, "X02"),
      pair(5, "X02"),
      pair(5, "X03"),
      ...Array.from({ length: 5 }, (_, index) => pair(index + 1, "X99")),
    ];
    const result = interferenceCalibration(duplicated);
    expect(result.verdict).toBe("incomplete");
    expect(result.repetitions).toBe(4);
    expect(result.scenarioSamples).toEqual({ X02: 4, X03: 4 });
    expect(result.classified).toBe(8);
    expect(result.excluded).toBe(8);
  });
  it("reports uncertainty even with no observed interference", () => {
    expect(rateInterval(0, 10)?.[1]).toBeCloseTo(0.2775, 4);
    expect(rateInterval(0, 0)).toBeUndefined();
  });
  it("does not treat the threshold that itself pauses the thread as sufficient", () => {
    expect(
      turnBudgetCalibration([{ successful: true, botMessages: 4, paused: false }])
        .observedMinimumBudget,
    ).toBe(5);
    expect(
      turnBudgetCalibration([{ successful: true, botMessages: 4, paused: true }])
        .observedMinimumBudget,
    ).toBeUndefined();
    expect(
      turnBudgetCalibration([{ successful: false, botMessages: 8, paused: true }])
        .observedMinimumBudget,
    ).toBeUndefined();
  });
});
