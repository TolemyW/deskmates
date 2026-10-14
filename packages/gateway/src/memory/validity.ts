// Validity intervals (ADR-0011 decision 6): a superseded entry is closed, never overwritten. Its
// row stays readable with `invalid_at` and `superseded_by`; TTL expiry and a closed interval both
// take an entry out of the pinned index and the search results. Which entry is superseded is
// decided by recency (amendment 2, `recency.ts`).

import type { MemoryEntry } from "@deskmates/contracts";

/** Whether an entry is in force at `now`: not forgotten, interval open, TTL not run out. */
export function isLive(
  entry: Pick<
    MemoryEntry,
    "tombstoned" | "invalidAt" | "ttlSeconds" | "lastConfirmedAt" | "observedAt"
  >,
  now: Date,
): boolean {
  if (entry.tombstoned) return false;
  if (entry.invalidAt !== undefined && Date.parse(entry.invalidAt) <= now.getTime()) return false;
  if (entry.ttlSeconds !== undefined) {
    const since = Date.parse(entry.lastConfirmedAt ?? entry.observedAt);
    if (since + entry.ttlSeconds * 1000 <= now.getTime()) return false;
  }
  return true;
}
