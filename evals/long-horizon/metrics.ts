import type {
  RunContextMetrics,
  RunEvent,
  RunTimeline,
  RunUsageReceipt,
  UsageCoverage,
} from "@deskmates/contracts";
import { toolNameOf } from "../../acceptance/support/runs.js";

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreateTokens",
] as const;
export type Tokens = Record<(typeof TOKEN_FIELDS)[number], number | null>;

export interface RunObservation {
  runId: string;
  status: string;
  attempt: number;
  /** Each physical attempt is retained; tokens below belong to the whole logical run. */
  attempts: RunTimeline["attempts"];
  coverage: UsageCoverage;
  usageReceipts: RunUsageReceipt[];
  recordedConfig: Record<string, unknown> | null;
  context: RunContextMetrics | null;
  tokens: Tokens;
  costUsd: number | null;
  toolCalls: number;
  toolErrors: number;
  l2Calls: number;
  events: RunEvent[];
  ledgerContiguous: boolean;
  reply?: string;
}

/** Missing/partial cumulative receipts are lower bounds, never complete zero usage. */
export function usageMetrics(
  rows: readonly RunUsageReceipt[],
  coverage: UsageCoverage,
): { tokens: Tokens; costUsd: number | null } {
  const complete =
    (coverage === "complete" || coverage === "not_started") &&
    !rows.some((r) => r.attributionUncertain);
  const sum = (field: (typeof TOKEN_FIELDS)[number] | "costUsd"): number | null => {
    if (!complete || rows.some((r) => r[field] === null || !Number.isFinite(r[field]))) return null;
    if (rows.length === 0 && coverage !== "not_started") return null;
    return rows.reduce((n, r) => n + (r[field] ?? 0), 0);
  };
  return {
    tokens: {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreateTokens: sum("cacheCreateTokens"),
    },
    costUsd: sum("costUsd"),
  };
}

export function observeRun(input: {
  runId: string;
  status: string;
  attempt: number;
  usage: RunUsageReceipt[];
  coverage: UsageCoverage;
  events: RunEvent[];
  timeline: RunTimeline;
  reply?: string;
  recordedConfig?: Record<string, unknown>;
  context?: RunContextMetrics;
}): RunObservation {
  const calls = input.events.filter((e) => e.kind === "tool_call");
  return {
    runId: input.runId,
    status: input.status,
    attempt: input.attempt,
    attempts: input.timeline.attempts,
    coverage: input.coverage,
    usageReceipts: input.usage,
    recordedConfig: input.recordedConfig ?? null,
    context: input.context ?? null,
    ...usageMetrics(input.usage, input.coverage),
    toolCalls: calls.length,
    toolErrors: input.events.filter((e) => e.kind === "tool_result" && e.payload.isError === true)
      .length,
    l2Calls: calls.filter((e) => e.payload.riskLevel === "L2").length,
    events: input.events,
    ledgerContiguous: input.events.length > 0 && input.events.every((e, i) => e.seq === i + 1),
    ...(input.reply === undefined ? {} : { reply: input.reply }),
  };
}

export function totals(
  observations: readonly RunObservation[],
  knownRunIds: readonly string[] = [],
  options: { inventoryComplete?: boolean; unavailableRunIds?: readonly string[] } = {},
): {
  logicalRuns: number | null;
  knownLogicalRuns: number;
  inventoryComplete: boolean;
  physicalAttempts: number | null;
  observedPhysicalAttempts: number;
  unknownAttemptRuns: number;
  unobservedRunIds: string[];
  tokens: Tokens;
  costUsd: number | null;
  unknownUsageRuns: number;
  turns: number | null;
  toolCalls: number;
  toolsByName: Record<string, number>;
} {
  // A run resumed across several phases must contribute its cumulative usage only once.
  const runs = [...new Map(observations.map((o) => [o.runId, o])).values()];
  const inventoryComplete = options.inventoryComplete ?? true;
  const allKnownIds = new Set([
    ...knownRunIds,
    ...runs.map((r) => r.runId),
    ...(options.unavailableRunIds ?? []),
  ]);
  const unavailable = new Set(options.unavailableRunIds ?? []);
  const unobservedRunIds = [...allKnownIds].filter(
    (id) => unavailable.has(id) || !runs.some((r) => r.runId === id),
  );
  const accountedRuns = runs.filter((r) => !unavailable.has(r.runId));
  const tokens: Tokens = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  };
  for (const field of TOKEN_FIELDS)
    tokens[field] =
      !inventoryComplete || unobservedRunIds.length || runs.some((r) => r.tokens[field] === null)
        ? null
        : runs.reduce((n, r) => n + (r.tokens[field] ?? 0), 0);
  const toolsByName: Record<string, number> = {};
  for (const run of runs)
    for (const event of run.events.filter((e) => e.kind === "tool_call")) {
      const name = toolNameOf(event);
      toolsByName[name] = (toolsByName[name] ?? 0) + 1;
    }
  const started = (run: RunObservation) =>
    run.attempts.filter((a) => a.stages.some((s) => s.stage === "attempt_started" && s.observed))
      .length;
  const unknownAttemptRuns =
    unobservedRunIds.length +
    accountedRuns.filter((r) => r.coverage !== "not_started" && started(r) < r.attempt).length;
  const observedPhysicalAttempts = runs.reduce((n, r) => n + started(r), 0);
  return {
    logicalRuns: inventoryComplete ? allKnownIds.size : null,
    knownLogicalRuns: allKnownIds.size,
    inventoryComplete,
    physicalAttempts: !inventoryComplete || unknownAttemptRuns ? null : observedPhysicalAttempts,
    observedPhysicalAttempts,
    unknownAttemptRuns,
    unobservedRunIds,
    tokens,
    costUsd:
      !inventoryComplete || unobservedRunIds.length || runs.some((r) => r.costUsd === null)
        ? null
        : runs.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    unknownUsageRuns:
      unobservedRunIds.length +
      accountedRuns.filter(
        (r) =>
          !["complete", "not_started"].includes(r.coverage) ||
          TOKEN_FIELDS.some((field) => r.tokens[field] === null),
      ).length,
    toolCalls: runs.reduce((n, r) => n + r.toolCalls, 0),
    turns:
      !inventoryComplete || unobservedRunIds.length || runs.some((r) => r.context === null)
        ? null
        : runs.reduce((n, r) => n + (r.context?.turns ?? 0), 0),
    toolsByName,
  };
}
