// Operator edits of learned memory (ADR-0011 decisions 5 and 7). Every change is a new immutable
// version; forget tombstones the entry and redacts the body of every prior version; undo restores
// the previous version verbatim; confirm makes an entry trusted with the human as its source.

import { DeskmatesError, type WorkspaceId, memoryFact } from "@deskmates/contracts";
import type { MemoryEntryStore, StoredEntry } from "./entries.js";

export const MEMORY_BODY_MAX_BYTES = 4096;

export function assertExpectedMemoryVersion(actual: number, expected?: number): void {
  if (expected !== undefined && actual !== expected)
    throw new DeskmatesError(
      "invalid_transition",
      "Memory changed since you opened it; reload its latest version before saving",
      { expectedVersion: expected, currentVersion: actual },
    );
}

export function validMemoryBody(body: unknown): string {
  if (typeof body !== "string" || body.trim() === "")
    throw new DeskmatesError("validation", "Expected a non-empty memory body");
  const trimmed = body.trim();
  if (Buffer.byteLength(trimmed) > MEMORY_BODY_MAX_BYTES)
    throw new DeskmatesError("payload_too_large", "Memory body is larger than 4096 bytes");
  return trimmed;
}

function live(store: MemoryEntryStore, workspaceId: WorkspaceId, id: string): StoredEntry {
  const entry = store.mustGetIn(workspaceId, id);
  if (entry.tombstoned)
    throw new DeskmatesError("invalid_transition", "This memory entry was forgotten");
  return entry;
}

export function editEntry(
  store: MemoryEntryStore,
  workspaceId: WorkspaceId,
  id: string,
  body: unknown,
  by: string,
  expectedVersion?: number,
): StoredEntry {
  const valid = validMemoryBody(body);
  return store.db.transaction(() => {
    const current = live(store, workspaceId, id);
    assertExpectedMemoryVersion(current.version, expectedVersion);
    store.appendVersion(id, "edit", { body: valid }, by);
    return rekey(store, id, by, new Date());
  })();
}

/**
 * After a human edit the body may state another fact. The edited note takes the new key and,
 * when it is current, is a human statement made now: it supersedes the other current note of
 * that key (A9). A closed note only takes the key.
 */
function rekey(store: MemoryEntryStore, id: string, by: string, now: Date): StoredEntry {
  const entry = store.mustGet(id);
  const key = entry.kind === "note" ? memoryFact(entry.body).key : undefined;
  const at = now.toISOString();
  const current =
    entry.invalidAt === undefined && !entry.episodeId && key !== undefined
      ? store.currentFor(entry.workspaceId, entry.scope, entry, key)
      : undefined;
  if (current && current.id !== entry.id) {
    store.closeForSupersession(current.id, at, by);
    store.setFactKey(id, key, at);
    store.advanceEffective(id, at, "human");
    store.linkSupersession({
      entry: store.mustGet(current.id),
      winner: store.mustGet(id),
      reason: "newer_effective_time",
      by,
      at,
    });
  } else store.setFactKey(id, key, entry.effectiveAt);
  return store.mustGet(id);
}

export function forgetEntry(
  store: MemoryEntryStore,
  workspaceId: WorkspaceId,
  id: string,
  by: string,
): StoredEntry {
  const entry = store.mustGetIn(workspaceId, id);
  if (entry.tombstoned) return entry;
  return store.tombstone(id, by);
}

/** Restore the version before the current one: body, authority, trust and source as they were. */
export function undoEntry(
  store: MemoryEntryStore,
  workspaceId: WorkspaceId,
  id: string,
  by: string,
): StoredEntry {
  const entry = live(store, workspaceId, id);
  if (entry.invalidAt !== undefined && store.version(id, entry.version)?.op === "supersede")
    return restoreSuperseded(store, entry, by);
  const previous = store.version(id, entry.version - 1);
  if (!previous) throw new DeskmatesError("invalid_transition", "Nothing to undo");
  if (previous.redacted)
    throw new DeskmatesError("invalid_transition", "That version was redacted");
  return store.db.transaction(() => {
    store.appendVersion(
      id,
      "undo",
      {
        body: previous.body,
        authority: previous.authority,
        trust: previous.trust,
        sourceKind: previous.sourceKind,
      },
      by,
    );
    return rekey(store, id, by, new Date());
  })();
}

/**
 * A12: undo of a supersession. The closed note becomes current again, the note then current for
 * its fact is closed with reason `undo_restore`, and both keep every version and source.
 */
function restoreSuperseded(store: MemoryEntryStore, entry: StoredEntry, by: string): StoredEntry {
  return store.db.transaction(() => {
    const at = new Date().toISOString();
    const current =
      entry.factKey !== undefined
        ? store.currentFor(entry.workspaceId, entry.scope, entry, entry.factKey)
        : undefined;
    if (current) store.closeForSupersession(current.id, at, by);
    store.reopen(entry.id, at);
    const restored = store.appendVersion(entry.id, "undo", {}, by);
    if (current)
      store.linkSupersession({
        entry: store.mustGet(current.id),
        winner: restored,
        reason: "undo_restore",
        by,
        at,
      });
    return store.mustGet(entry.id);
  })();
}

/**
 * A human vouches for the entry: trusted, the human as source, confirmed now. A confirmed bot
 * candidate becomes part of the bot's experience, since a human may write it directly.
 */
export function confirmEntry(
  store: MemoryEntryStore,
  workspaceId: WorkspaceId,
  id: string,
  by: string,
): StoredEntry {
  live(store, workspaceId, id);
  return store.appendVersion(
    id,
    "confirm",
    {
      trust: "trusted",
      sourceKind: "human",
      lastConfirmedAt: new Date().toISOString(),
      promoteCandidate: true,
    },
    by,
  );
}
