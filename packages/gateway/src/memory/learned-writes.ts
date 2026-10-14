// A run's learned items become memory without a human decision (ADR-0011 decisions 1, 2 and 4):
// each is redacted, classified, deduplicated and applied, or gated into "needs your confirmation".
// Scope `rule` is refused with a typed error: SOUL, approval rules, risk tiers and egress change
// only through the operator API, and nothing here touches them. A gated duty-changing item that a
// human approves becomes a memory note, never a rule.
//
// Stores per scope: task -> a note on the thread; workspace -> a note every bot in the workspace
// reads; bot -> a candidate, which only consolidation or a human turns into experience.

import {
  type BotId,
  DeskmatesError,
  type LearnedItem,
  type MemoryScope,
  type MemorySupersessionReason,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  memoryDisposition,
  memoryEffectiveTime,
} from "@deskmates/contracts";
import type { ConfirmationStore, StoredConfirmation } from "./confirmations.js";
import type { MemoryEntryStore, StoredEntry, StoredScope } from "./entries.js";
import { type FactWriteResult, writeFact } from "./recency.js";
import { sanitizeMemoryBody } from "./sanitize.js";
import { MEMORY_BODY_MAX_BYTES } from "./versions.js";

export interface MemoryStores {
  entries: MemoryEntryStore;
  confirmations: ConfirmationStore;
}

export interface LearnedRun {
  runId: RunId;
  botId: BotId;
  workspaceId: WorkspaceId;
  threadId?: ThreadId;
  /** Human rule text in force for this bot (approval rules, egress entries); contradiction input. */
  rules: readonly string[];
  failed?: boolean;
  /** The source run's creation: the lower bound of a sidecar time stamp (A9). */
  createdAt?: string;
}

export type LearnedOutcome =
  | { ordinal: number; outcome: "applied"; entryId: string; superseded: string[] }
  | { ordinal: number; outcome: "deduplicated"; entryId: string }
  /** Kept as closed history: older than the current value, or a lower-trust copy (A9, A10). */
  | {
      ordinal: number;
      outcome: "history";
      entryId: string;
      currentId: string;
      reason: MemorySupersessionReason;
    }
  /** A redelivered item already written: nothing changed (A8). */
  | { ordinal: number; outcome: "replayed"; entryId: string }
  | { ordinal: number; outcome: "gated"; confirmationId: string; reasons: string[] }
  | { ordinal: number; outcome: "refused"; code: "memory_rule_refused"; message: string }
  | { ordinal: number; outcome: "skipped"; reason: string };

/** ADR-0011 item 1: a learned write may never be a rule. */
export function assertLearnedScope(scope: MemoryScope): asserts scope is StoredScope {
  if (scope === "rule")
    throw new DeskmatesError(
      "memory_rule_refused",
      "A learned item cannot write a rule; rules change only through the operator API",
      { scope },
    );
}

/** One item. Throws `memory_rule_refused` for scope `rule`; everything else returns an outcome. */
export function writeLearnedItem(
  stores: MemoryStores,
  run: LearnedRun,
  item: LearnedItem,
  ordinal: number,
  now: Date = new Date(),
): LearnedOutcome {
  assertLearnedScope(item.proposedScope);
  const scope = item.proposedScope;
  const body = sanitizeMemoryBody(item.body);
  // A16: the category shown to operators is the one applied here.
  const disposition = memoryDisposition(
    { ...item, body: body || item.body },
    { rules: run.rules, ...(run.failed ? { failedRun: true } : {}) },
  );
  if (disposition.category === "skipped")
    return { ordinal, outcome: "skipped", reason: disposition.skipReason ?? "failed_run" };
  if (!body) return { ordinal, outcome: "skipped", reason: "empty body" };
  if (Buffer.byteLength(body) > MEMORY_BODY_MAX_BYTES)
    return { ordinal, outcome: "skipped", reason: "body larger than 4096 bytes" };
  if (scope === "task" && !run.threadId)
    return { ordinal, outcome: "skipped", reason: "task state needs a thread" };
  // The sidecar sets trust; an item without it (an older sidecar, a legacy field) is untrusted.
  const trust = item.trust === "trusted" ? "trusted" : "untrusted";
  const sourceKind = item.sourceKind ?? (trust === "trusted" ? "bot_self" : "tool");

  // A6: a contradiction with a trusted note is a newer value, ordered below; not a gate.
  if (disposition.category === "rule_confirmation") {
    const reasons = disposition.reasons ?? [];
    const gated = stores.confirmations.gate({
      workspaceId: run.workspaceId,
      runId: run.runId,
      botId: run.botId,
      ...(scope === "task" && run.threadId ? { threadId: run.threadId } : {}),
      ordinal,
      body,
      proposedScope: scope,
      authority: item.authority,
      trust,
      sourceKind,
      reasons,
    });
    return {
      ordinal,
      outcome: "gated",
      confirmationId: gated.id,
      reasons: [...reasons],
    };
  }

  const effective = memoryEffectiveTime({
    ...(item.observedAt ? { stampedAt: item.observedAt } : {}),
    ...(run.createdAt ? { runCreatedAt: run.createdAt } : {}),
    receivedAt: now.toISOString(),
  });
  const result = writeFact(
    stores.entries,
    {
      workspaceId: run.workspaceId,
      scope,
      kind: scope === "bot" ? "candidate" : "note",
      ...(scope === "bot" ? { botId: run.botId } : {}),
      ...(scope === "task" && run.threadId ? { threadId: run.threadId } : {}),
      body,
      authority: item.authority,
      trust,
      sourceRunId: run.runId,
      ordinal,
      sourceKind,
      derivedFrom: [run.runId],
      observedAt: effective.at,
      effectiveAt: effective.at,
      effectiveBasis: effective.basis,
      by: `bot:${run.botId}`,
    },
    now,
  );
  return factOutcome(ordinal, result);
}

/** The ledger's view of a recency decision (A8 to A10). */
export function factOutcome(ordinal: number, result: FactWriteResult): LearnedOutcome {
  switch (result.kind) {
    case "current":
      return {
        ordinal,
        outcome: "applied",
        entryId: result.entry.id,
        superseded: result.superseded,
      };
    case "history":
      return {
        ordinal,
        outcome: "history",
        entryId: result.entry.id,
        currentId: result.winnerId,
        reason: result.reason,
      };
    case "consolidated":
      return { ordinal, outcome: "deduplicated", entryId: result.entry.id };
    case "replayed":
      return { ordinal, outcome: "replayed", entryId: result.entry.id };
  }
}

/** A run's items in order; a refused item is recorded and the rest still apply. */
export function writeLearnedItems(
  stores: MemoryStores,
  run: LearnedRun,
  items: readonly LearnedItem[],
  now: Date = new Date(),
): LearnedOutcome[] {
  return items.map((item, ordinal) => {
    try {
      return writeLearnedItem(stores, run, item, ordinal, now);
    } catch (error) {
      if (error instanceof DeskmatesError && error.code === "memory_rule_refused")
        return { ordinal, outcome: "refused", code: "memory_rule_refused", message: error.message };
      throw error;
    }
  });
}

/**
 * A human applies a gated item: it becomes a trusted note with the human as source, supersedes
 * what it contradicts, and never changes SOUL, an approval rule, a risk tier or egress.
 */
export function applyConfirmation(
  stores: MemoryStores,
  confirmationId: string,
  by: string,
  now: Date = new Date(),
): { suggestion: StoredConfirmation; entry: StoredEntry } {
  const current = stores.confirmations.get(confirmationId);
  if (current.status === "applied" && current.entryId)
    return { suggestion: current, entry: stores.entries.mustGet(current.entryId) };
  if (current.status !== "pending")
    throw new DeskmatesError("invalid_transition", "Memory suggestion has already been rejected");
  return stores.entries.db.transaction(() => {
    // A human decision is a source at the time it is made: newer than what it replaces (A9).
    const result = writeFact(
      stores.entries,
      {
        workspaceId: current.workspaceId,
        scope: current.proposedScope,
        kind: "note",
        ...(current.proposedScope === "bot" ? { botId: current.botId } : {}),
        ...(current.proposedScope === "task" && current.threadId
          ? { threadId: current.threadId }
          : {}),
        body: current.body,
        authority: current.authority,
        trust: "trusted",
        sourceRunId: current.runId,
        sourceKind: "human",
        derivedFrom: [current.id, current.runId, ...current.derivedFrom],
        observedAt: now.toISOString(),
        effectiveAt: now.toISOString(),
        effectiveBasis: "human",
        lastConfirmedAt: now.toISOString(),
        by,
      },
      now,
    );
    const entry = result.entry;
    return { suggestion: stores.confirmations.applied(current.id, by, entry.id), entry };
  })();
}
