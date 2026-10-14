// Persist evidence before teardown, attempt every owned cleanup, and write the verdict last.
// This records callback completion; best-effort stopStack is NOT verified resource absence.
/** Never retain arbitrary exception text: child argv and assertion diffs can contain secrets. */
export function domainErrorKind(error: unknown): string {
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  return error instanceof Error ? "Error" : "NonError";
}

export async function finalizeDomainAttempt(options: {
  oraclePassed: boolean;
  evidence: { name: string; run(): Promise<void> }[];
  cleanup: { name: string; run(): Promise<void> }[];
  afterCleanup?: { name: string; run(): Promise<void> }[];
  save(name: string, data: unknown): void;
}): Promise<void> {
  const failures: { stage: "evidence" | "cleanup"; name: string; error: string }[] = [];
  for (const stage of ["evidence", "cleanup"] as const) {
    for (const step of options[stage]) {
      try {
        await step.run();
      } catch (error) {
        failures.push({ stage, name: step.name, error: domainErrorKind(error) });
      }
    }
  }
  for (const step of options.afterCleanup ?? []) {
    try {
      await step.run();
    } catch (error) {
      failures.push({ stage: "evidence", name: step.name, error: domainErrorKind(error) });
    }
  }
  const evidenceComplete =
    options.evidence.some((step) => step.name === "run") &&
    !failures.some((f) => f.stage === "evidence");
  const cleanupCallbacksCompleted = !failures.some((f) => f.stage === "cleanup");
  options.save("verdict.json", {
    passed: options.oraclePassed && evidenceComplete && cleanupCallbacksCompleted,
    oraclePassed: options.oraclePassed,
    evidenceComplete,
    cleanupCallbacksCompleted,
    resourceAbsenceVerified: false,
    failures,
  });
  if (failures.length)
    throw new AggregateError(
      failures.map((f) => Error(`${f.stage}/${f.name}: ${f.error}`)),
      "domain evidence or cleanup failed",
    );
  if (options.oraclePassed && !evidenceComplete) throw Error("domain run evidence is missing");
}
