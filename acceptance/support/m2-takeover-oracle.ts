export interface X04TakeoverChecks {
  bothRunsSucceeded: boolean;
  bothRunsMarkedTaken: boolean;
  bothRunsMarkedHandedBack: boolean;
  peerSawWaitEvent: boolean;
  aSawDashboardAfterHandback: boolean;
  bUsedBrowserAfterHandback: boolean;
  separateTabs: boolean;
  ledgerHasNoTakeoverScreenshots: boolean;
  sseHasNoTakeoverScreenshots: boolean;
  siteMfaPassed: boolean;
}

/** Canonical X04 is a runtime/state oracle; it does not define a final-answer format. */
export function failedX04TakeoverChecks(checks: X04TakeoverChecks): string[] {
  return Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
}
