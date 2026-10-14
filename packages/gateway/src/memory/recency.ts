// Silent supersession (ADR-0011 amendment 2, issue #85): a note of a known fact becomes current
// when it is newer than the current value, is kept as closed history when it is older, and is
// folded into the current note as one more source when it says the same thing at the same trust.
// Nothing here asks a human. One transaction decides; the unique index on current notes is the
// guarantee that a fact never has two current values.

import { type MemorySupersessionReason, compareRecency, memoryFact } from "@deskmates/contracts";
import { newId } from "../db/ids.js";
import type { MemoryEntryStore, NewEntry, StoredEntry } from "./entries.js";

export type FactWriteResult =
  /** The note is current; `superseded` lists what it closed. */
  | { kind: "current"; entry: StoredEntry; superseded: string[] }
  /** Stored already closed: older than the current value, or a lower-trust copy of it. */
  | { kind: "history"; entry: StoredEntry; winnerId: string; reason: MemorySupersessionReason }
  /** Same value, same trust: recorded as one more source of `entry` (A10). */
  | { kind: "consolidated"; entry: StoredEntry }
  /** The same (run, ordinal) was written before: nothing changed (A8). */
  | { kind: "replayed"; entry: StoredEntry };

export interface FactWrite extends NewEntry {
  effectiveAt: string;
}

const owner = (entry: Pick<NewEntry, "scope" | "botId" | "threadId">) => ({
  ...(entry.scope === "bot" && entry.botId ? { botId: entry.botId } : {}),
  ...(entry.scope === "task" && entry.threadId ? { threadId: entry.threadId } : {}),
});

/** Close `loser` in favour of `winner`, in that order, so the unique index never sees two. */
function supersede(
  store: MemoryEntryStore,
  loser: StoredEntry,
  winner: () => StoredEntry,
  reason: MemorySupersessionReason,
  by: string,
  at: string,
): StoredEntry {
  store.closeForSupersession(loser.id, at, by);
  const won = winner();
  store.linkSupersession({ entry: store.mustGet(loser.id), winner: won, reason, by, at });
  return won;
}

/**
 * Give rows written before amendment 2 a key and an effective time (their observation time). Two
 * current notes of one key found here are ordered like any other pair, with reason `backfill`.
 */
export function backfillFactKeys(
  store: MemoryEntryStore,
  workspaceId: StoredEntry["workspaceId"],
  now: Date = new Date(),
): void {
  const rows = store.unkeyed(workspaceId);
  if (rows.length === 0) return;
  const at = now.toISOString();
  store.db.transaction(() => {
    for (const row of rows) {
      const live =
        row.kind === "note" && !row.tombstoned && row.invalidAt === undefined && !row.episodeId;
      const key = row.kind === "note" ? memoryFact(row.body).key : undefined;
      if (!live || key === undefined) {
        store.setFactKey(row.id, key, row.observedAt);
        continue;
      }
      const current = store.currentFor(workspaceId, row.scope, owner(row), key);
      if (!current) {
        store.setFactKey(row.id, key, row.observedAt);
        continue;
      }
      const order = compareRecency(
        { id: row.id, effectiveAt: row.observedAt, ingestedAt: row.ingestedAt },
        current,
      );
      if (order.incomingWins)
        supersede(
          store,
          current,
          () => {
            store.setFactKey(row.id, key, row.observedAt);
            return store.mustGet(row.id);
          },
          "backfill",
          "system:memory-backfill",
          at,
        );
      else {
        store.closeForSupersession(row.id, at, "system:memory-backfill");
        store.setFactKey(row.id, key, row.observedAt);
        store.linkSupersession({
          entry: store.mustGet(row.id),
          winner: current,
          reason: "backfill",
          by: "system:memory-backfill",
          at,
        });
      }
    }
  })();
}

/**
 * Write one note or candidate under the recency policy. Candidates and bodies without a fact key
 * are only deduplicated by their normalised body at the same trust; keyed notes follow A8 to A10.
 */
export function writeFact(
  store: MemoryEntryStore,
  input: FactWrite,
  now: Date = new Date(),
): FactWriteResult {
  return store.db.transaction((): FactWriteResult => {
    if (input.sourceRunId && input.ordinal !== undefined) {
      const earlier = store.entryForItem(input.sourceRunId, input.ordinal);
      if (earlier) return { kind: "replayed", entry: earlier };
    }
    backfillFactKeys(store, input.workspaceId, now);
    const at = now.toISOString();
    const fact = memoryFact(input.body);
    const key = input.kind === "note" ? fact.key : undefined;
    const source = (entry: StoredEntry) => {
      store.addSource({
        workspaceId: entry.workspaceId,
        entryId: entry.id,
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
        sourceKind: input.sourceKind,
        trust: input.trust,
        effectiveAt: input.effectiveAt,
        effectiveBasis: input.effectiveBasis ?? "ingest",
        recordedAt: at,
      });
      store.advanceEffective(entry.id, input.effectiveAt, input.effectiveBasis ?? "ingest");
      return { kind: "consolidated" as const, entry: store.mustGet(entry.id) };
    };

    if (key === undefined) {
      const duplicate = store.findDuplicate(
        input.workspaceId,
        input.scope,
        input.body,
        owner(input),
        input.trust,
      );
      if (duplicate && duplicate.kind === input.kind) return source(duplicate);
      return { kind: "current", entry: store.insert({ ...input, ingestedAt: at }), superseded: [] };
    }

    const current = store.currentFor(input.workspaceId, input.scope, owner(input), key);
    const id = newId("mem");
    const fresh: NewEntry = { ...input, id, factKey: key, ingestedAt: at };
    if (!current) return { kind: "current", entry: store.insert(fresh), superseded: [] };

    const keep = (reason: MemorySupersessionReason): FactWriteResult => {
      // Inserted closed, then given its `supersede` version, so undo can restore it (A12).
      store.insert({ ...fresh, invalidAt: at });
      store.closeForSupersession(id, at, input.by);
      store.linkSupersession({
        entry: store.mustGet(id),
        winner: current,
        reason,
        by: input.by,
        at,
      });
      return { kind: "history", entry: store.mustGet(id), winnerId: current.id, reason };
    };
    const replace = (reason: MemorySupersessionReason): FactWriteResult => {
      const entry = supersede(store, current, () => store.insert(fresh), reason, input.by, at);
      return { kind: "current", entry, superseded: [current.id] };
    };

    if (memoryFact(current.body).value === fact.value) {
      if (current.trust === input.trust) return source(current);
      return input.trust === "trusted"
        ? replace("equivalent_higher_trust")
        : keep("equivalent_lower_trust");
    }
    const order = compareRecency({ id, effectiveAt: input.effectiveAt, ingestedAt: at }, current);
    return order.incomingWins ? replace(order.reason) : keep(order.reason);
  })();
}
