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
// - contextSections, systemPromptSha256 and its static and dynamic parts (ADR-0023 amendment 5)
//   are the latest attempt's `context_sections` event;
// - maxContextTokens is the latest `sdk` init log's, else the run config's `RunEnded` value;
// - modelRequests counts forwarded `messages` requests only (`count_tokens` is not a turn, and a
//   request the proxy refused never reached a model);
// - contextUsage is the `context_usage` samples (ADR-0023 amendment 5): the first in ledger
//   order, the latest, and how many; a warning without numbers is not a sample;
// - sessionStarts is every `session_start` event, in ledger order;
// - requestShapes summarises the forwarded `messages` requests that carried a shape, null when
//   none did.
// A value with no data behind it is null, never 0.

import type {
  RunCompaction,
  RunContextMetrics,
  RunContextUsageSample,
  RunEvent,
  RunRequestShapeSummary,
  RunSessionStart,
} from "@deskmates/contracts";
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

function usageSample(e: RunEvent): RunContextUsageSample | null {
  const p = e.payload;
  const total = count(p.totalTokens);
  const max = count(p.maxTokens);
  if (total === null || max === null) return null;
  const categories = Array.isArray(p.categories)
    ? p.categories.flatMap((c: unknown) => {
        const row = c as { name?: unknown; kind?: unknown; tokens?: unknown } | null;
        return row && typeof row.name === "string"
          ? [
              {
                name: row.name,
                kind: typeof row.kind === "string" ? row.kind : "used",
                tokens: num(row.tokens),
              },
            ]
          : [];
      })
    : [];
  return {
    attempt: e.attempt ?? 1,
    detail: p.detail === "full" ? "full" : "summary",
    turn: num(p.turn),
    totalTokens: total,
    maxTokens: max,
    percentage: num(p.percentage),
    categories,
  };
}

/** What the proxy saw across the run's forwarded requests; null when none carried a shape. */
function shapeSummary(messages: readonly ModelRequestRecord[]): RunRequestShapeSummary | null {
  const shaped = messages.flatMap((r) => (r.shape ? [{ attempt: r.attempt, shape: r.shape }] : []));
  if (shaped.length === 0) return null;
  const staticHashes = new Set<string>();
  const dynamicHashes = new Set<string>();
  const staticByAttempt = new Map<number, Set<string>>();
  const blockValues = new Map<number, Set<string>>();
  let withCacheControl = 0;
  let maxSystemChars = 0;
  let maxToolsCount = 0;
  let maxToolsChars = 0;
  let maxMessages = 0;
  for (const { attempt, shape } of shaped) {
    if (shape.cacheControlBlocks > 0) withCacheControl++;
    if (shape.systemStaticSha256 !== undefined) {
      staticHashes.add(shape.systemStaticSha256);
      const set = staticByAttempt.get(attempt) ?? new Set<string>();
      set.add(shape.systemStaticSha256);
      staticByAttempt.set(attempt, set);
    }
    if (shape.systemDynamicSha256 !== undefined) dynamicHashes.add(shape.systemDynamicSha256);
    shape.systemBlockHashes.forEach((hash, i) => {
      const set = blockValues.get(i) ?? new Set<string>();
      set.add(hash);
      blockValues.set(i, set);
    });
    maxSystemChars = Math.max(maxSystemChars, shape.systemChars);
    maxToolsCount = Math.max(maxToolsCount, shape.toolsCount);
    maxToolsChars = Math.max(maxToolsChars, shape.toolsChars);
    maxMessages = Math.max(maxMessages, shape.messagesCount);
  }
  return {
    measured: shaped.length,
    withCacheControl,
    distinctStaticHashes: staticHashes.size,
    distinctDynamicHashes: dynamicHashes.size,
    staticChangedWithinAttempt: [...staticByAttempt.values()].some((s) => s.size > 1),
    changedSystemBlocks: [...blockValues.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([i]) => i)
      .sort((a, b) => a - b),
    maxSystemChars,
    maxToolsCount,
    maxToolsChars,
    maxMessages,
  };
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
  let staticHash: string | null = null;
  let dynamicHash: string | null = null;
  let firstUsage: RunContextUsageSample | null = null;
  let latestUsage: RunContextUsageSample | null = null;
  let usageSamples = 0;
  const sessionStarts: RunSessionStart[] = [];

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
      staticHash =
        typeof p.systemPromptStaticSha256 === "string" ? p.systemPromptStaticSha256 : null;
      dynamicHash =
        typeof p.systemPromptDynamicSha256 === "string" ? p.systemPromptDynamicSha256 : null;
    } else if (e.kind === "log" && p.kind === "context_usage") {
      const sample = usageSample(e);
      if (sample !== null) {
        usageSamples++;
        firstUsage ??= sample;
        latestUsage = sample;
      }
    } else if (e.kind === "log" && p.kind === "session_start") {
      sessionStarts.push({
        attempt: e.attempt ?? 1,
        source: typeof p.sessionSource === "string" ? p.sessionSource : "unknown",
        contextTokens: count(p.contextTokens),
        promptCacheLikelyExpired:
          typeof p.promptCacheLikelyExpired === "boolean" ? p.promptCacheLikelyExpired : null,
      });
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
    systemPromptStaticSha256: staticHash,
    systemPromptDynamicSha256: dynamicHash,
    modelRequests: {
      count: messages.length,
      distinctSystemHashes: distinct.size,
      changedWithinAttempt: [...hashesByAttempt.values()].some((s) => s.size > 1),
    },
    contextUsage: { samples: usageSamples, first: firstUsage, latest: latestUsage },
    sessionStarts,
    requestShapes: shapeSummary(messages),
  };
}
