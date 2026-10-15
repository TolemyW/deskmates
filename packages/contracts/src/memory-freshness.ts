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

/**
 * The horizons in force, recorded on every flag row (A25). Owner ruling 2026-10-14: 1 day for
 * workspace and bot notes (the first guesses were 90 and 180); the model recheck (A28) answers
 * the daily volume, not a human.
 */
export interface MemoryFreshnessPolicy {
  workspaceDays: number;
  botDays: number;
  expiringDays: number;
}

export const DEFAULT_MEMORY_FRESHNESS_POLICY: MemoryFreshnessPolicy = {
  workspaceDays: 1,
  botDays: 1,
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

/** The model's answer about one flagged note (A28). */
export const MEMORY_RECHECK_VERDICTS = ["still_true", "possibly_stale", "unclear"] as const;
export type MemoryRecheckVerdict = (typeof MEMORY_RECHECK_VERDICTS)[number];

/** Flag reasons the model may recheck; `replaced_trusted` stays a human's (A28). */
export const MEMORY_RECHECK_REASONS: readonly MemoryFreshnessReason[] = [
  "age",
  "ttl_expiring",
  "ttl_expired",
];
/** The most notes one recheck job reads (A28). */
export const MEMORY_RECHECK_MAX_NOTES = 20;
/** A verdict's reason is cut to this many characters (A28). */
export const MEMORY_RECHECK_REASON_MAX_CHARS = 200;

/** `decided_by` and the `confirm` version's `by` of a model confirmation (A28). */
export function decidedByModelRun(runId: string): string {
  return `model:${runId}`;
}

/** Whether a `decided_by` names a model confirmation rather than a person (A28). */
export function isModelDecision(by: string | undefined): boolean {
  return by?.startsWith("model:") === true;
}

/**
 * The recheck reply: one JSON object `{verdicts: [{id, verdict, reason}]}`. Items with an
 * unknown verdict or no id are dropped; anything that is not such an object is undefined.
 */
export function parseMemoryRecheckReply(
  reply: string,
): { id: string; verdict: MemoryRecheckVerdict; reason: string }[] | undefined {
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(reply.trim());
  const text = (fenced ? (fenced[1] as string) : reply).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const verdicts = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(verdicts)) return undefined;
  const out: { id: string; verdict: MemoryRecheckVerdict; reason: string }[] = [];
  for (const item of verdicts) {
    const v = item as { id?: unknown; verdict?: unknown; reason?: unknown } | null;
    if (typeof v?.id !== "string" || v.id === "") continue;
    if (!(MEMORY_RECHECK_VERDICTS as readonly unknown[]).includes(v.verdict)) continue;
    const reason = typeof v.reason === "string" ? v.reason.replace(/\s+/g, " ").trim() : "";
    out.push({
      id: v.id,
      verdict: v.verdict as MemoryRecheckVerdict,
      reason: reason.slice(0, MEMORY_RECHECK_REASON_MAX_CHARS),
    });
  }
  return out;
}

/** The latest model verdict on a flag (A28). */
export interface MemoryRecheckOutcome {
  verdict: MemoryRecheckVerdict;
  reason: string;
  checkedAt: string;
  runId: string;
  /** The note version the verdict was about. */
  entryVersion: number;
}

/** One recheck job of a workspace (A28). */
export interface MemoryRecheckJob {
  id: string;
  workspaceId: string;
  status: "pending" | "ready" | "failed";
  runId: string;
  noteCount: number;
  stillTrue: number;
  possiblyStale: number;
  unclear: number;
  dropped: number;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

/** Per-workspace maintenance settings (A34). */
export interface MemoryMaintenanceSettings {
  /** Notes the model may recheck per workspace per day; 0 turns rechecks off. */
  recheckDailyLimit: number;
  /** Whether model organisation runs once a day on its own. */
  organizeDaily: boolean;
}

export const DEFAULT_MEMORY_MAINTENANCE_SETTINGS: MemoryMaintenanceSettings = {
  recheckDailyLimit: 200,
  organizeDaily: true,
};
export const MEMORY_RECHECK_DAILY_LIMIT_MAX = 1000;

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
  /** The model's latest verdict on this flag (A28), if it was rechecked. */
  model?: MemoryRecheckOutcome;
  /** `replaced_trusted`, or a `possibly_stale` model verdict: waits for a person (A26). */
  needsHuman: boolean;
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
