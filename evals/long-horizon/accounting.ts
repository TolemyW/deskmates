// Discovery and failures are cumulative across captures, including non-phase background jobs.
import { type RunObservation, totals } from "./metrics.js";
import type { DeploymentObservation } from "./observer.js";

export class MissionRunAccounting {
  private readonly knownRunIds = new Set<string>();
  private readonly unavailableRunIds = new Set<string>();
  private inventorySeen = false;
  private inventoryFailed = false;

  capture(snapshot: DeploymentObservation | undefined): void {
    if (!snapshot) {
      this.inventoryFailed = true;
      return;
    }
    this.inventorySeen = true;
    if (!snapshot.inventoryComplete) this.inventoryFailed = true;
    for (const run of snapshot.runs) {
      this.knownRunIds.add(run.runId);
      this.unavailableRunIds.delete(run.runId);
    }
    for (const error of snapshot.errors) {
      this.knownRunIds.add(error.runId);
      this.unavailableRunIds.add(error.runId);
    }
  }

  totals(
    runs: readonly RunObservation[],
    phaseRunIds: readonly string[] = [],
  ): ReturnType<typeof totals> {
    for (const id of phaseRunIds) this.knownRunIds.add(id);
    return totals(runs, [...this.knownRunIds], {
      inventoryComplete: this.inventorySeen && !this.inventoryFailed,
      unavailableRunIds: [...this.unavailableRunIds],
    });
  }
}
