// Per-run context metrics (M3 context plan, Phase 1), computed on read from the run's ledger
// events and its `model_requests` rows. Nothing is aggregated into a table: the events are the
// truth, and a metric defined differently next month recomputes over every old run.
//
// Definitions:
// - a turn is one `turn_usage` event (one model response, `turn-usage.ts` in the sidecar);
// - a turn's input window is `inputTokens + cacheReadTokens + cacheCreateTokens`, everything the
//   model read on that turn; peak is the largest, p95 the nearest-rank 95th percentile;
// - cacheHitRatio is sum(cacheRead) / sum(cacheRead + cacheCreate + input) over the turns;
// - peak/p95 and the cache ratio are unknown if any contributing turn lacks measurements;
// - contextSections and systemPromptSha256 are the latest attempt's `context_sections` event;
// - maxContextTokens is the latest `sdk` init log's, else the run config's `RunEnded` value;
// - modelRequests counts forwarded `messages` requests only (`count_tokens` is not a turn, and a
//   request the proxy refused never reached a model).
// A value with no data behind it is null, never 0.

import type { RunCompaction, RunContextMetrics, RunEvent } from "@deskmates/contracts";
import type { ModelRequestRecord } from "./model-requests.js";
export type { RunCompaction, RunContextMetrics } from "@deskmates/contracts";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Nearest-rank percentile of an ascending list; `p` in (0, 1]. */
function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function runContextMetrics(
  events: readonly RunEvent[],
  requests: readonly ModelRequestRecord[],
  runConfig: Readonly<Record<string, unknown>> = {},
): RunContextMetrics {
  const windows: number[] = [];
  let cacheRead = 0;
  let input = 0;
  let cacheCreate = 0;
  let turns = 0;
  let complete = true;
  const compactions: RunCompaction[] = [];
  let sections: Record<string, number> | null = null;
  let hash: string | null = null;
  let window = positive(runConfig.claudeCodeMaxContextTokens);

  for (const e of events) {
    const p = e.payload;
    if (e.kind === "turn_usage") {
      turns++;
      const i = count(p.inputTokens);
      const r = count(p.cacheReadTokens);
      const c = count(p.cacheCreateTokens);
      if (i === null || r === null || c === null) {
        complete = false;
      } else {
        windows.push(i + r + c);
        input += i;
        cacheRead += r;
        cacheCreate += c;
      }
    } else if (e.kind === "compact_boundary") {
      compactions.push({
        attempt: e.attempt ?? 1,
        seq: e.seq,
        trigger: typeof p.trigger === "string" ? p.trigger : "unknown",
        preTokens: num(p.preTokens),
        ...(typeof p.postTokens === "number" ? { postTokens: p.postTokens } : {}),
      });
    } else if (e.kind === "log" && p.kind === "context_sections") {
      // Events come in ledger order, so the last one is the latest attempt's.
      if (p.sections !== null && typeof p.sections === "object") {
        sections = Object.fromEntries(
          Object.entries(p.sections as Record<string, unknown>).map(([k, v]) => [k, num(v)]),
        );
      }
      hash = typeof p.systemPromptSha256 === "string" ? p.systemPromptSha256 : null;
    } else if (e.kind === "log" && p.source === "sdk" && positive(p.maxContextTokens) !== null) {
      window = positive(p.maxContextTokens);
    }
  }

  const sorted = [...windows].sort((a, b) => a - b);
  const messages = requests.filter((r) => r.requestKind === "messages" && r.refusal === null);
  const hashesByAttempt = new Map<number, Set<string>>();
  for (const r of messages) {
    if (r.systemSha256 === null) continue;
    const set = hashesByAttempt.get(r.attempt) ?? new Set<string>();
    set.add(r.systemSha256);
    hashesByAttempt.set(r.attempt, set);
  }
  const distinct = new Set(
    messages.flatMap((r) => (r.systemSha256 === null ? [] : [r.systemSha256])),
  );

  return {
    turns,
    peakInputTokens: complete ? (sorted.at(-1) ?? null) : null,
    p95InputTokens: complete ? nearestRank(sorted, 0.95) : null,
    cacheHitRatio:
      complete && cacheRead + cacheCreate + input > 0
        ? cacheRead / (cacheRead + cacheCreate + input)
        : null,
    compactions,
    contextSections: sections,
    systemPromptSha256: hash,
    maxContextTokens: window,
    modelRequests: {
      count: messages.length,
      distinctSystemHashes: distinct.size,
      changedWithinAttempt: [...hashesByAttempt.values()].some((s) => s.size > 1),
    },
  };
}
