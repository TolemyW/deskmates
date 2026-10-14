// Recency for learned memory (ADR-0011 amendment 2): what "the same fact" is (A7), which of two
// values of one fact is current (A9), and the words a supersession receipt uses (A10 to A12).
// Pure functions: the Gateway decides with them and trace replay can recompute the decision.

import type { RunId } from "./ids.js";
import { type MemorySourceKind, type MemoryTrust, memoryTextShape } from "./memory.js";

/** Where a note's effective time came from, best first (A9). */
export const MEMORY_EFFECTIVE_BASES = ["source", "run", "human", "ingest"] as const;
export type MemoryEffectiveBasis = (typeof MEMORY_EFFECTIVE_BASES)[number];

/** Why one note stopped being current (A9, A10, A12, backfill of notes written before A7). */
export const MEMORY_SUPERSESSION_REASONS = [
  "backfill",
  "equivalent_higher_trust",
  "equivalent_lower_trust",
  "newer_effective_time",
  "older_arrival",
  "tie_entry_id",
  "tie_later_ingestion",
  "undo_restore",
] as const;
export type MemorySupersessionReason = (typeof MEMORY_SUPERSESSION_REASONS)[number];

/** How a version reached a run's model context (A13). */
export type MemorySupplyVia = "pinned" | "search";

/** One source of a note: the write that created it, or an equivalent copy consolidated into it. */
export interface MemoryEntrySource {
  entryId: string;
  sourceRunId?: RunId;
  /** The item's position in its run's summary; with the run, the idempotency key (A8). */
  ordinal?: number;
  sourceKind: MemorySourceKind;
  trust: MemoryTrust;
  effectiveAt: string;
  effectiveBasis: MemoryEffectiveBasis;
  recordedAt: string;
}

/** The receipt of one supersession: `entryId` closed, `winnerId` current for `factKey`. */
export interface MemorySupersession {
  id: string;
  entryId: string;
  winnerId: string;
  factKey: string;
  reason: MemorySupersessionReason;
  entryEffectiveAt: string;
  winnerEffectiveAt: string;
  decidedBy: string;
  createdAt: string;
}

/** A fact's identity (`key`, absent when the body has no content word) and its stated value. */
export interface MemoryFact {
  key?: string;
  value: string;
}

const ISO_DATE_TIME =
  /\b\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?\b/g;
const CONDITION_WORD =
  /\b(version|v|release|build|rev|api|since|before|after|until)\s+(\d+(?:\.\d+)*)/gi;
const CAPITALISED_NAME = /\b([A-Z][\w.+-]*)\s+(\d+(?:\.\d+)*)/g;

const condition = (number: string) => `cond_${number.replaceAll(".", "_")}`;

/**
 * A7: the key is the sorted set of content words, with condition numbers (after a capitalised
 * name or a condition word) folded in as words; ISO dates and times are dropped. The other
 * numbers and the polarity are the value. Word order is not part of the key, a known limit
 * measured as false supersession.
 */
export function memoryFact(body: string): MemoryFact {
  const text = body
    .normalize("NFKC")
    .replace(ISO_DATE_TIME, " ")
    .replace(CONDITION_WORD, (_, word: string, number: string) => `${word} ${condition(number)}`)
    .replace(CAPITALISED_NAME, (whole: string, name: string, number: string) =>
      // "The 20 seats": a sentence-initial stopword is not a product name.
      memoryTextShape(name).content.size === 0 ? whole : `${name} ${condition(number)}`,
    );
  const shape = memoryTextShape(text);
  const value = `${shape.negative ? "not" : "is"}|${[...shape.numbers].sort().join(",")}`;
  if (shape.content.size === 0) return { value };
  return { key: [...shape.content].sort().join(" "), value };
}

/**
 * A9: a note's effective time. A sidecar stamp is accepted within the source run's lifetime
 * (creation to receipt) and clamped to it otherwise; without one the run's creation time is used;
 * without a run, the time of receipt. Text the model wrote is never read as a clock.
 */
export function memoryEffectiveTime(input: {
  stampedAt?: string;
  runCreatedAt?: string;
  receivedAt: string;
}): { at: string; basis: MemoryEffectiveBasis; clamped?: "future" | "before_run" } {
  const upper = Date.parse(input.receivedAt);
  const run = input.runCreatedAt === undefined ? Number.NaN : Date.parse(input.runCreatedAt);
  const lower = Number.isNaN(run) ? Number.NEGATIVE_INFINITY : Math.min(run, upper);
  const stamped = input.stampedAt === undefined ? Number.NaN : Date.parse(input.stampedAt);
  if (!Number.isNaN(stamped)) {
    if (stamped > upper)
      return { at: new Date(upper).toISOString(), basis: "source", clamped: "future" };
    if (stamped < lower)
      return { at: new Date(lower).toISOString(), basis: "source", clamped: "before_run" };
    return { at: new Date(stamped).toISOString(), basis: "source" };
  }
  if (Number.isFinite(lower)) return { at: new Date(lower).toISOString(), basis: "run" };
  return { at: new Date(upper).toISOString(), basis: "ingest" };
}

/** What ordering reads of a note. */
export interface RecencyStamp {
  id: string;
  effectiveAt: string;
  /** When the Gateway stored it. */
  ingestedAt: string;
}

/**
 * A9: whether `incoming` is newer than `current`, and the recorded reason. Effective time first,
 * then ingestion time, then the entry id, so every pair has exactly one answer.
 */
export function compareRecency(
  incoming: RecencyStamp,
  current: RecencyStamp,
): { incomingWins: boolean; reason: MemorySupersessionReason } {
  const effective = Date.parse(incoming.effectiveAt) - Date.parse(current.effectiveAt);
  if (effective !== 0)
    return {
      incomingWins: effective > 0,
      reason: effective > 0 ? "newer_effective_time" : "older_arrival",
    };
  const ingested = Date.parse(incoming.ingestedAt) - Date.parse(current.ingestedAt);
  if (ingested !== 0)
    return {
      incomingWins: ingested > 0,
      reason: ingested > 0 ? "tie_later_ingestion" : "older_arrival",
    };
  return {
    incomingWins: incoming.id > current.id,
    reason: incoming.id > current.id ? "tie_entry_id" : "older_arrival",
  };
}
