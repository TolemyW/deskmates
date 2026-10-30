import { describe, expect, it } from "vitest";
import { MissionRunAccounting } from "./accounting.js";
import type { RunObservation } from "./metrics.js";
import type { DeploymentObservation } from "./observer.js";

const main: RunObservation = {
  runId: "run_phase",
  status: "succeeded",
  attempt: 1,
  attempts: [],
  coverage: "complete",
  usageReceipts: [],
  recordedConfig: {},
  context: null,
  tokens: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 },
  costUsd: 0.2,
  toolCalls: 1,
  toolErrors: 0,
  l2Calls: 0,
  events: [],
  ledgerContiguous: true,
};
function snapshot(
  runs: RunObservation[],
  errors: DeploymentObservation["errors"] = [],
): DeploymentObservation {
  return { runs, errors, inventoryComplete: true };
}

describe("mission accounting across observer captures", () => {
  it("includes a failed-observation background job even when no phase references its id", () => {
    const scope = new MissionRunAccounting();
    scope.capture(snapshot([main], [{ runId: "run_background", error: "GET failed" }]));
    const counts = scope.totals([main], [main.runId]);
    expect(counts).toMatchObject({
      logicalRuns: 2,
      knownLogicalRuns: 2,
      inventoryComplete: true,
      unknownUsageRuns: 1,
      costUsd: null,
      tokens: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
      },
      unobservedRunIds: ["run_background"],
    });
    // A later persist without another capture must keep the discovered job.
    expect(scope.totals([main], [main.runId])).toEqual(counts);
  });
  it("does not reuse stale finite usage after a previously observed job's GET fails", () => {
    const background = { ...main, runId: "run_background" };
    const scope = new MissionRunAccounting();
    scope.capture(snapshot([main, background]));
    expect(scope.totals([main, background]).costUsd).toBe(0.4);
    scope.capture(snapshot([main], [{ runId: background.runId, error: "GET failed" }]));
    expect(scope.totals([main, background])).toMatchObject({
      logicalRuns: 2,
      unknownUsageRuns: 1,
      costUsd: null,
      tokens: { inputTokens: null },
      unobservedRunIds: [background.runId],
    });
    scope.capture(snapshot([background]));
    expect(scope.totals([main, background])).toMatchObject({
      logicalRuns: 2,
      unknownUsageRuns: 0,
      costUsd: 0.4,
    });
  });
  it("keeps the whole inventory total unknown after a complete inventory failure", () => {
    const scope = new MissionRunAccounting();
    scope.capture(snapshot([main]));
    scope.capture(undefined);
    expect(scope.totals([main])).toMatchObject({
      logicalRuns: null,
      knownLogicalRuns: 1,
      inventoryComplete: false,
      physicalAttempts: null,
      costUsd: null,
      tokens: { inputTokens: null },
    });
    // A subsequent read cannot erase the historical inventory gap in this mission receipt.
    scope.capture(snapshot([main]));
    expect(scope.totals([main]).inventoryComplete).toBe(false);
  });
  it("retains discovered ids from an incomplete paginated inventory", () => {
    const scope = new MissionRunAccounting();
    scope.capture({
      runs: [main],
      errors: [{ runId: "run_background", error: "GET failed" }],
      inventoryComplete: false,
      inventoryError: "page 2 failed",
    });
    expect(scope.totals([main])).toMatchObject({
      logicalRuns: null,
      knownLogicalRuns: 2,
      inventoryComplete: false,
      unknownUsageRuns: 1,
      costUsd: null,
      tokens: { inputTokens: null },
      unobservedRunIds: ["run_background"],
    });
  });
});
