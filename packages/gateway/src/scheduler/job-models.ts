// Background jobs that run on the cheap model (ADR-0023 decision 2). This list is the one place
// that says which job kinds do; a later kind that should is added here and nowhere else. The job
// kind is the only input: no prompt text, thread message, memory entry or tool output is read.
//
// A listed job writes `model` and `cheapModel` into its run config at creation, so the existing
// freezing (`run-lifecycle.ts`, `effectiveModels`) carries the choice to the sidecar unchanged,
// a resume keeps it, and the model proxy enforces it like any other frozen pair.

/** Job kinds (`runs.config_json.runType`) that run on the cheap model. */
export const CHEAP_MODEL_JOB_KINDS = [
  "activity_summary",
  "memory_consolidation",
  "soul_proposal",
  "status_inquiry",
] as const;

export type CheapModelJobKind = (typeof CHEAP_MODEL_JOB_KINDS)[number];

function isCheapModelJob(kind: unknown): kind is CheapModelJobKind {
  return (CHEAP_MODEL_JOB_KINDS as readonly unknown[]).includes(kind);
}

/**
 * The model keys a job's run config is created with: both the cheap model for a listed kind,
 * nothing for any other kind, which then selects as every run does (run config, bot, default).
 */
export function modelsForJob(
  kind: unknown,
  cheapModel: string,
): { model: string; cheapModel: string } | Record<string, never> {
  return isCheapModelJob(kind) ? { model: cheapModel, cheapModel } : {};
}
