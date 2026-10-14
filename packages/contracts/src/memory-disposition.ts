// Organization of learned memory without a model (ADR-0011 amendment 3): the category a learned
// item goes to (A16), the review group of a gated item (A17), the topic tag of an entry (A20), and
// the operator views of groups and batch dispositions (A18, A19).

import type { BotId, ThreadId, WorkspaceId } from "./ids.js";
import { memoryFact } from "./memory-recency.js";
import {
  type ConfirmationReason,
  type DoNotLearnReason,
  type LearnedItem,
  type MemoryConfirmation,
  type MemoryScope,
  type MemoryTrust,
  classifyLearnedItem,
  doNotLearnReason,
  memoryTextShape,
  normaliseMemoryBody,
} from "./memory.js";

export const MEMORY_CATEGORIES = [
  "task_history",
  "workspace_observation",
  "experience_candidate",
  "rule_confirmation",
  "skipped",
  "refused",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryDisposition {
  category: MemoryCategory;
  /** Why it is gated (`rule_confirmation`). */
  reasons?: ConfirmationReason[];
  /** Why it is not learned (`skipped`). */
  skipReason?: DoNotLearnReason;
}

/**
 * A16: where a learned item goes, decided by the same rules the Gateway applies. Order matters:
 * a rule-scope write is refused first, then do-not-learn, then the confirmation gate, then the
 * proposed scope names the store. A contradiction with a trusted entry is not a gate (A6).
 */
export function memoryDisposition(
  item: Pick<LearnedItem, "body" | "proposedScope" | "sourceKind" | "doNotLearnReasons">,
  context: { rules: readonly string[]; failedRun?: boolean },
): MemoryDisposition {
  if (item.proposedScope === "rule") return { category: "refused" };
  const skipReason: DoNotLearnReason | undefined = context.failedRun
    ? "failed_run"
    : (item.doNotLearnReasons?.[0] ?? doNotLearnReason(item.body, item.sourceKind));
  if (skipReason) return { category: "skipped", skipReason };
  const gate = classifyLearnedItem({ body: item.body }, { rules: context.rules });
  if (gate.decision === "gate") return { category: "rule_confirmation", reasons: gate.reasons };
  return {
    category:
      item.proposedScope === "task"
        ? "task_history"
        : item.proposedScope === "workspace"
          ? "workspace_observation"
          : "experience_candidate",
  };
}

/**
 * A17: two gated items are one review group when they are in the same store, at the same trust,
 * and state the same fact with the same value; a body without a fact key groups by its
 * normalised text. The key is readable on purpose: it is compared, never parsed.
 */
export function memoryReviewGroupKey(item: {
  workspaceId: string;
  proposedScope: Exclude<MemoryScope, "rule">;
  botId?: string;
  threadId?: string;
  trust: MemoryTrust;
  body: string;
}): string {
  const fact = memoryFact(item.body);
  const owner =
    item.proposedScope === "bot"
      ? (item.botId ?? "")
      : item.proposedScope === "task"
        ? (item.threadId ?? "")
        : "";
  const what = fact.key ? `k:${fact.key}|${fact.value}` : `b:${normaliseMemoryBody(item.body)}`;
  return [item.workspaceId, item.proposedScope, owner, item.trust, what].join("\u001f");
}

const NAME_LIKE =
  /^(?:[A-Z][\p{L}\p{N}_.+-]*|[\p{L}_]*\p{N}[\p{L}\p{N}_.+-]*|[a-z]+[A-Z][\p{L}\p{N}_]*)$/u;

/**
 * A20: the topic tag of a note. The first name-like word (capitalised and not a stopword, or
 * containing a digit or an inner capital), else the first content word; `key` is lower-cased
 * for filtering, `label` is the word as first written. A body without either has no topic.
 */
export function memoryTopic(body: string): { key: string; label: string } | undefined {
  const words = body.normalize("NFKC").match(/[\p{L}\p{N}_][\p{L}\p{N}_.+-]*/gu) ?? [];
  const clean = (word: string) => word.replace(/[.+-]+$/u, "");
  for (const raw of words) {
    const word = clean(raw);
    if (!NAME_LIKE.test(word) || /^\p{N}+$/u.test(word)) continue;
    if (memoryTextShape(word).content.size === 0) continue;
    if (COMMON_SENTENCE_STARTS.has(word.toLowerCase())) continue;
    return { key: word.toLowerCase(), label: word };
  }
  const first = [...memoryTextShape(body).content].find((token) => !token.startsWith("cond_"));
  if (!first) return undefined;
  // CJK: content tokens are single characters; the first two of their run read as a word.
  const han = /^\p{Script=Han}$/u.test(first)
    ? body.normalize("NFKC").match(/\p{Script=Han}{1,2}/u)?.[0]
    : undefined;
  const label =
    han ?? words.map(clean).find((word) => word.toLowerCase().startsWith(first)) ?? first;
  return { key: label.toLowerCase(), label };
}

/** Capitalised only because they start a sentence or an instruction: never a topic. */
const COMMON_SENTENCE_STARTS = new Set([
  "after",
  "all",
  "always",
  "before",
  "do",
  "each",
  "every",
  "for",
  "from",
  "if",
  "most",
  "never",
  "no",
  "only",
  "please",
  "some",
  "there",
  "these",
  "they",
  "those",
  "use",
  "when",
  "we",
  "you",
]);

// ---------------------------------------------------------------------------------------------
// Operator views
// ---------------------------------------------------------------------------------------------

/** One review group of the pending queue (A17). */
export interface MemoryReviewGroup {
  groupKey: string;
  workspaceId: WorkspaceId;
  proposedScope: Exclude<MemoryScope, "rule">;
  trust: MemoryTrust;
  botId?: BotId;
  threadId?: ThreadId;
  /** Pending items in the group. */
  count: number;
  /** The pending items, oldest first, at most 50: wording, source run and reasons per item. */
  items: MemoryConfirmation[];
  oldestAt: string;
  newestAt: string;
}

export type MemoryBatchDecision = "reject" | "merge";

/** The most items one batch disposition decides (A18). */
export const MEMORY_BATCH_MAX = 50;

/** What a batch would do, before it is committed (A18). */
export interface MemoryBatchPreview {
  groupKey: string;
  decision: MemoryBatchDecision;
  /** The items it decides, oldest first. */
  itemIds: string[];
  /** For `merge`: the item applied as the note; the others become its sources. */
  representativeId?: string;
  /** Pending items of the group left for a later batch. */
  remaining: number;
  /** Commit with this token; it changes when any item changes. */
  token: string;
}

export interface MemoryReviewBatch {
  id: string;
  workspaceId: WorkspaceId;
  groupKey: string;
  decision: MemoryBatchDecision;
  itemIds: string[];
  /** For `merge`: the note the group was applied to. */
  entryId?: string;
  /** For `merge`: whether this batch created the note (only then is it undoable). */
  createdEntry: boolean;
  decidedBy: string;
  createdAt: string;
  undoneBy?: string;
  undoneAt?: string;
}
