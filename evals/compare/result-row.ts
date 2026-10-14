// One line of `evals/results/<date>-<label>.jsonl`: one run of one task under one configuration
// (evals/README.md, `run.ts`). `compare.ts` reads only the fields named here; every other field
// the runner writes (git sha, model, served model, gateway, site and task-set versions, bot config
// hash, knob config, wall time, interventions, first failing step) passes through untouched.

export type DurationBucket = "short" | "medium" | "long";

export interface ResultRow {
  taskId: string;
  bucket: DurationBucket;
  /** Page cluster from the task set; informational here, the pairing unit is the task. */
  cluster?: string;
  /** Which of the K attempts at this task this was, from 1. */
  repeat?: number;
  success: boolean;
  failureReason?: string | null;
  /** Behavioral fingerprint (measurement §3.5): named numeric dimensions. */
  fingerprint?: Record<string, number>;
  /** Gateway-priced cost of the run; null or absent when unknown (unpriced model, lost usage). */
  costUsd?: number | null;
  [other: string]: unknown;
}

const BUCKETS: ReadonlySet<string> = new Set<DurationBucket>(["short", "medium", "long"]);

/** Parses a JSONL results file; blank lines are skipped, a malformed line is an error. */
export function parseResultFile(text: string, name = "results"): ResultRow[] {
  const rows: ResultRow[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${name}:${index + 1}: not JSON`);
    }
    const r = raw as Partial<ResultRow>;
    if (typeof r.taskId !== "string" || r.taskId === "") {
      throw new Error(`${name}:${index + 1}: taskId missing`);
    }
    if (typeof r.bucket !== "string" || !BUCKETS.has(r.bucket)) {
      throw new Error(`${name}:${index + 1}: bucket must be short, medium or long`);
    }
    if (typeof r.success !== "boolean") {
      throw new Error(`${name}:${index + 1}: success must be a boolean`);
    }
    rows.push(raw as ResultRow);
  });
  return rows;
}
