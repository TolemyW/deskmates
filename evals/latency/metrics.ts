// Startup-latency distributions from derived run timelines (ADR-0037 decisions 3 and 6).
//
// Definitions, all per attempt and measured from the attempt's `submitted` stage (the triggering
// message for attempt 1, the releasing decision for a resume):
//   - firstRequest: the first inference request the model proxy saw;
//   - ttft: the first content delta the sidecar saw (any kind of token);
//   - firstText: the first text delta;
//   - firstVisible: the first text a human could read (preview, thread_post or final reply);
//   - e2e: the attempt's end (`run_ended`, else `attempt_closed`).
// Attempts are grouped by class: start (fresh/resume), SDK session (new/resumed), sandbox
// (created/attached/cached) and whether the SDK retried a model call. A stage an attempt never
// observed is counted as missing, never as zero. Percentiles are nearest-rank over observed values.

import {
  type RunAttemptTimeline,
  type RunTimelineStageName,
  buildRunTimeline,
  timelineStage,
} from "@deskmates/contracts";
import type { LatencyRun } from "./load.js";

export const LATENCY_METRICS = [
  "firstRequest",
  "ttft",
  "firstText",
  "firstVisible",
  "e2e",
] as const;
export type LatencyMetric = (typeof LATENCY_METRICS)[number];

const METRIC_STAGE: Readonly<Record<Exclude<LatencyMetric, "e2e">, RunTimelineStageName>> = {
  firstRequest: "first_upstream_request",
  ttft: "first_token",
  firstText: "first_text",
  firstVisible: "first_visible_text",
};

export interface Distribution {
  observed: number;
  missing: number;
  p50: number | null;
  p95: number | null;
}

export interface ClassSummary {
  key: string;
  attempts: number;
  metrics: Record<LatencyMetric, Distribution>;
  outcomes: Record<string, number>;
}

export interface LatencySummary {
  runs: number;
  /** Runs whose ledger has no timeline mark at all: recorded before ADR-0037, or jobs filtered. */
  runsWithoutMarks: number;
  attempts: number;
  classes: ClassSummary[];
  /** Attempts by SDK retry count: "0", "1", "2", "3+". */
  retries: Record<string, number>;
  /** Attempts by the first response's cache-read share of its input window. */
  firstTurnCacheRead: Record<string, number>;
  /** Attempt outcomes over every class. */
  outcomes: Record<string, number>;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function distribution(values: readonly (number | null)[]): Distribution {
  const observed = values.filter((v): v is number => v !== null);
  return {
    observed: observed.length,
    missing: values.length - observed.length,
    p50: percentile(observed, 50),
    p95: percentile(observed, 95),
  };
}

export function attemptClass(attempt: RunAttemptTimeline): string {
  return [
    attempt.start,
    `session-${attempt.session}`,
    `sandbox-${attempt.sandbox}`,
    attempt.modelRetries > 0 ? "retried" : "no-retry",
  ].join(" / ");
}

function metricValue(attempt: RunAttemptTimeline, metric: LatencyMetric): number | null {
  if (metric === "e2e") {
    return (
      timelineStage(attempt, "run_ended")?.sinceStartMs ??
      timelineStage(attempt, "attempt_closed")?.sinceStartMs ??
      null
    );
  }
  return timelineStage(attempt, METRIC_STAGE[metric])?.sinceStartMs ?? null;
}

function cacheBucket(attempt: RunAttemptTimeline): string {
  const usage = attempt.firstTurnUsage;
  if (!usage || usage.cacheReadTokens === null || usage.inputTokens === null) return "unknown";
  const window = usage.inputTokens + usage.cacheReadTokens + (usage.cacheCreateTokens ?? 0);
  if (window === 0) return "unknown";
  const share = usage.cacheReadTokens / window;
  if (share === 0) return "0";
  if (share < 0.5) return "<50%";
  if (share < 0.9) return "50-90%";
  return ">=90%";
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Attempts of agent runs with at least one timeline mark; jobs only when `includeJobs`. */
export function summarizeLatency(
  runs: readonly LatencyRun[],
  opts: { includeJobs?: boolean } = {},
): LatencySummary {
  const groups = new Map<string, RunAttemptTimeline[]>();
  const retries: Record<string, number> = {};
  const cache: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  let considered = 0;
  let without = 0;
  let attempts = 0;
  for (const run of runs) {
    if (run.runType && !opts.includeJobs) continue;
    considered += 1;
    if (!run.events.some((e) => e.kind === "log" && e.payload.source === "run_timeline")) {
      without += 1;
      continue;
    }
    for (const attempt of buildRunTimeline(run).attempts) {
      if (!attempt.stages.some((s) => s.stage === "attempt_started" && s.observed)) continue;
      attempts += 1;
      const key = attemptClass(attempt);
      const list = groups.get(key) ?? [];
      list.push(attempt);
      groups.set(key, list);
      bump(retries, attempt.modelRetries >= 3 ? "3+" : String(attempt.modelRetries));
      bump(cache, cacheBucket(attempt));
      bump(outcomes, attempt.outcome ?? (attempt.closed ? "closed" : "open"));
    }
  }
  const classes = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, list]): ClassSummary => {
      const metrics = {} as Record<LatencyMetric, Distribution>;
      for (const metric of LATENCY_METRICS)
        metrics[metric] = distribution(list.map((a) => metricValue(a, metric)));
      const classOutcomes: Record<string, number> = {};
      for (const a of list) bump(classOutcomes, a.outcome ?? (a.closed ? "closed" : "open"));
      return { key, attempts: list.length, metrics, outcomes: classOutcomes };
    });
  return {
    runs: considered,
    runsWithoutMarks: without,
    attempts,
    classes,
    retries,
    firstTurnCacheRead: cache,
    outcomes,
  };
}

function ms(value: number | null): string {
  return value === null ? "–" : `${value}`;
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? "none" : entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

export function renderLatencyMarkdown(summary: LatencySummary, source: string): string {
  const lines = [
    "# Run startup latency",
    "",
    `Source: \`${source}\` (read-only). Runs considered: ${summary.runs}; without timeline marks: ${summary.runsWithoutMarks}; attempts: ${summary.attempts}.`,
    "",
    "Milliseconds from the attempt's submission. `n` is the number of attempts that observed the stage; `missing` never counts as zero.",
    "Gateway and workspace clocks may differ (Colima VM); stages recorded by different processes include that skew.",
    "A faster first response is not quality evidence; compare equivalent configurations under the measurement protocol.",
    "",
  ];
  for (const c of summary.classes) {
    lines.push(`## ${c.key} (${c.attempts} attempts)`, "");
    lines.push("| metric | n | missing | p50 | p95 |", "|---|---|---|---|---|");
    for (const metric of LATENCY_METRICS) {
      const d = c.metrics[metric];
      lines.push(`| ${metric} | ${d.observed} | ${d.missing} | ${ms(d.p50)} | ${ms(d.p95)} |`);
    }
    lines.push("", `Outcomes: ${counts(c.outcomes)}`, "");
  }
  lines.push(
    "## Distributions",
    "",
    `- Outcomes: ${counts(summary.outcomes)}`,
    `- SDK model retries per attempt: ${counts(summary.retries)}`,
    `- First response cache-read share: ${counts(summary.firstTurnCacheRead)}`,
    "",
  );
  return lines.join("\n");
}
