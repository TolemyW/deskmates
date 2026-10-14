import { describe, expect, it } from "vitest";
import { type X04TakeoverChecks, failedX04TakeoverChecks } from "./m2-takeover-oracle.js";

const PASSING: X04TakeoverChecks = {
  bothRunsSucceeded: true,
  bothRunsMarkedTaken: true,
  bothRunsMarkedHandedBack: true,
  peerSawWaitEvent: true,
  aSawDashboardAfterHandback: true,
  bUsedBrowserAfterHandback: true,
  separateTabs: true,
  ledgerHasNoTakeoverScreenshots: true,
  sseHasNoTakeoverScreenshots: true,
  siteMfaPassed: true,
};

describe("canonical X04 takeover oracle", () => {
  it("passes from runtime and site evidence without requiring a final-answer shape", () => {
    expect(failedX04TakeoverChecks(PASSING)).toEqual([]);
  });

  it.each([
    "bothRunsSucceeded",
    "peerSawWaitEvent",
    "aSawDashboardAfterHandback",
    "ledgerHasNoTakeoverScreenshots",
    "sseHasNoTakeoverScreenshots",
    "siteMfaPassed",
  ] as const)("fails when %s is missing", (name) => {
    expect(failedX04TakeoverChecks({ ...PASSING, [name]: false })).toContain(name);
  });
});
