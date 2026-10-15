// Freshness of learned memory (ADR-0011 amendment 4, A25 to A27): which current notes a human
// should look at again, and why. A pure function of one entry, so the Gateway's sweep and a test
// table agree; it changes nothing a run receives.

import type { BotId, ThreadId, WorkspaceId } from "./ids.js";
import type { MemoryEntry } from "./memory.js";

/** Why a note needs revalidation, most urgent first (A25). */
export const MEMORY_FRESHNESS_REASONS = [
  "replaced_trusted",
  "ttl_expired",
  "ttl_expiring",
  "age",
] as const;
export type MemoryFreshnessReason = (typeof MEMORY_FRESHNESS_REASONS)[number];

/** The horizons in force; guesses recorded on every flag row, calibrated later (A25). */
export interface MemoryFreshnessPolicy {
  workspaceDays: number;
  botDays: number;
  expiringDays: number;
}

export const DEFAULT_MEMORY_FRESHNESS_POLICY: MemoryFreshnessPolicy = {
  workspaceDays: 90,
  botDays: 180,
  expiringDays: 7,
};

/** What freshness reads of an entry. */
export type FreshnessInput = Pick<
  MemoryEntry,
  | "scope"
  | "kind"
  | "trust"
  | "tombstoned"
  | "invalidAt"
  | "ttlSeconds"
  | "lastConfirmedAt"
  | "observedAt"
  | "effectiveAt"
> & {
  episodeId?: string;
  /** This note closed a trusted note when it became current (A11). */
  replacedTrusted?: boolean;
};

const DAY_MS = 86_400_000;

/**
 * A25: the reasons a note needs revalidation at `now`, most urgent first; empty when it needs
 * none. Task notes, episodes, candidates, forgotten and superseded notes are never flagged.
 */
export function memoryFreshness(
  entry: FreshnessInput,
  now: Date,
  policy: MemoryFreshnessPolicy = DEFAULT_MEMORY_FRESHNESS_POLICY,
): MemoryFreshnessReason[] {
  if (entry.kind !== "note" || entry.scope === "task") return [];
  if (entry.tombstoned || entry.episodeId) return [];
  // A closed interval is supersession, not expiry: the current value is elsewhere.
  if (entry.invalidAt !== undefined) return [];
  const reasons: MemoryFreshnessReason[] = [];
  const at = now.getTime();
  if (entry.replacedTrusted && entry.trust === "untrusted") reasons.push("replaced_trusted");
  if (entry.ttlSeconds !== undefined) {
    const expires = Date.parse(entry.lastConfirmedAt ?? entry.observedAt) + entry.ttlSeconds * 1000;
    if (expires <= at) reasons.push("ttl_expired");
    // A short TTL is "expiring" only in its second half, so renewing it does not re-flag it.
    else if (expires - at <= Math.min(policy.expiringDays * DAY_MS, (entry.ttlSeconds * 1000) / 2))
      reasons.push("ttl_expiring");
  }
  const effective = Date.parse(entry.effectiveAt ?? entry.observedAt);
  const confirmed = entry.lastConfirmedAt ? Date.parse(entry.lastConfirmedAt) : Number.NaN;
  const since = Number.isNaN(confirmed) ? effective : Math.max(effective, confirmed);
  const horizon = entry.scope === "bot" ? policy.botDays : policy.workspaceDays;
  if (at - since > horizon * DAY_MS) reasons.push("age");
  return reasons;
}

/** How a flag ended (A26, A27). */
export const MEMORY_REVALIDATION_OUTCOMES = [
  "open",
  "still_true",
  "dismissed",
  "resolved",
  "superseded",
  "forgotten",
] as const;
export type MemoryRevalidationOutcome = (typeof MEMORY_REVALIDATION_OUTCOMES)[number];

/** A human's answer to an open flag (A27). */
export type MemoryRevalidationDecision = "still_true" | "dismiss";

/** One row of "Needs revalidation", with the note as it is now. */
export interface MemoryRevalidation {
  id: string;
  workspaceId: WorkspaceId;
  entryId: string;
  /** The note version the flag was raised at. */
  entryVersion: number;
  reason: MemoryFreshnessReason;
  status: MemoryRevalidationOutcome;
  flaggedAt: string;
  /** The horizon of the note's scope when it was flagged, in days. */
  horizonDays: number;
  decidedBy?: string;
  decidedAt?: string;
  entry: {
    body: string;
    scope: "workspace" | "bot";
    trust: MemoryEntry["trust"];
    botId?: BotId;
    threadId?: ThreadId;
    version: number;
    effectiveAt: string;
    lastConfirmedAt?: string;
    ttlSeconds?: number;
    learnedBy?: string;
    sourceRunId?: string;
  };
}
