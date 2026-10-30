// What a campaign executor records about one run, before any grading (protocol of 2026-10-17).
// Executors (`acceptance/m4-*-eval.acceptance.test.ts`) write one JSON object per run into a
// report directory; the graders turn them into `compare.ts` rows. Keeping the two apart means a
// grader is a pure function a T0 test can pin, and a report can be re-graded without a model.

/** Common to every observation. A missing measurement is absent or null, never zero. */
export interface RunObservation {
  /** The task id in the task file (`RK-S01`, `AS-01@large`). */
  taskId: string;
  arm: string;
  /** Which of the K repetitions, from 1. */
  repeat: number;
  /** The run (or job run) the observation is about; absent when none was created. */
  runId?: string;
  /** Terminal run status as the ledger has it. */
  status?: string;
  /** Model ids the upstream named in its responses (ADR-0023 decision 3). */
  servedModels?: string[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Gateway-priced cost of the run, null when any part of it is unpriced. */
  costUsd?: number | null;
  /** Gateway-priced cost of runs the case started but does not measure (triage workers). */
  leakUsd?: number | null;
  wallMs?: number | null;
  /**
   * Set when the harness, not the model, failed: seeding, a missing job, a timeout of the
   * executor itself. A campaign with any harness error yields no verdict (stop rule S3).
   */
  harnessError?: string;
  /** Recorded configuration: git sha, image, models, task-set version, knob hash. */
  config?: Record<string, unknown>;
}

/** Observations from a report directory's `*.json` files, one object or an array per file. */
export function parseObservations(texts: readonly { name: string; text: string }[]): unknown[] {
  const out: unknown[] = [];
  for (const { name, text } of texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${name}: not JSON`);
    }
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out;
}

/** A finite number, or undefined: what a fingerprint dimension may hold. */
export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
