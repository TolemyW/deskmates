// Model organisation of learned memory (ADR-0011 amendment 4, A30 to A32): what the cheap-model
// job may propose and the deterministic checks its proposals pass before the Gateway keeps them.
// The model labels and proposes wordings; it never changes trust, scope, a decision or a rule.

import { classifyLearnedItem, doNotLearnReason, memoryTextShape } from "./memory.js";

/** The most notes one job reads (A30). */
export const MEMORY_ORGANIZE_MAX_NOTES = 40;
/** A split has 2 to this many parts (A32). */
export const MEMORY_SPLIT_MAX_PARTS = 5;

/** One note as the job sees it: its id and body, nothing else. */
export interface MemoryOrganizeNote {
  id: string;
  body: string;
}

/** The parsed reply, before validation. */
export interface MemoryOrganizeReply {
  labels: { id: string; label: string }[];
  splits: { id: string; parts: string[] }[];
}

function unfenced(text: string): string {
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return (fenced ? (fenced[1] as string) : text).trim();
}

/** One JSON object `{labels, splits}`; anything else is undefined, never a partial guess. */
export function parseMemoryOrganizeReply(reply: string): MemoryOrganizeReply | undefined {
  const text = unfenced(reply);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as { labels?: unknown; splits?: unknown };
  const labels: MemoryOrganizeReply["labels"] = [];
  const splits: MemoryOrganizeReply["splits"] = [];
  for (const item of Array.isArray(value.labels) ? value.labels : []) {
    const label = item as { id?: unknown; label?: unknown };
    if (typeof label?.id === "string" && typeof label.label === "string")
      labels.push({ id: label.id, label: label.label });
  }
  for (const item of Array.isArray(value.splits) ? value.splits : []) {
    const split = item as { id?: unknown; parts?: unknown };
    if (
      typeof split?.id === "string" &&
      Array.isArray(split.parts) &&
      split.parts.every((part) => typeof part === "string")
    )
      splits.push({ id: split.id, parts: split.parts as string[] });
  }
  return { labels, splits };
}

/** A31: a kept label, trimmed, or undefined when it is not a plain short tag. */
export function validTopicLabel(label: string): { key: string; label: string } | undefined {
  const trimmed = label.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > 40) return undefined;
  if (/[\r\n<>`*_#[\]{}|\\]/.test(trimmed)) return undefined;
  if (trimmed.split(/\s+/).length > 4) return undefined;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return undefined;
  return { key: trimmed.toLowerCase(), label: trimmed };
}

/** Why a proposed split is dropped (A32); undefined when it is kept. */
export type SplitRejection =
  | "part_count"
  | "empty_part"
  | "not_shorter"
  | "new_content"
  | "imperative"
  | "do_not_learn";

/**
 * A32: whether a proposed split of `original` adds nothing. Every part is non-empty, shorter than
 * the original, uses only content words and numbers of the original, and would not be gated or
 * filtered as a learned item on its own.
 */
export function splitRejection(
  original: string,
  parts: readonly string[],
): SplitRejection | undefined {
  if (parts.length < 2 || parts.length > MEMORY_SPLIT_MAX_PARTS) return "part_count";
  const source = memoryTextShape(original);
  const originalLength = original.trim().length;
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "") return "empty_part";
    if (part.length >= originalLength) return "not_shorter";
    const shape = memoryTextShape(part);
    for (const word of shape.content) if (!source.content.has(word)) return "new_content";
    for (const number of shape.numbers) if (!source.numbers.has(number)) return "new_content";
    if (classifyLearnedItem({ body: part }, { rules: [] }).decision === "gate") return "imperative";
    if (doNotLearnReason(part)) return "do_not_learn";
  }
  return undefined;
}

/** A pending or decided split proposal as the operator sees it. */
export interface MemorySplitProposal {
  id: string;
  workspaceId: string;
  entryId: string;
  entryVersion: number;
  /** The original body when the proposal was made. */
  body: string;
  parts: string[];
  status: "pending" | "accepted" | "rejected" | "undone";
  runId: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** The notes an accepted split wrote, in part order. */
  partEntryIds?: string[];
}

/** One organisation job of a workspace (A30). */
export interface MemoryOrganizeJob {
  id: string;
  workspaceId: string;
  status: "pending" | "ready" | "failed";
  runId: string;
  noteCount: number;
  labelsKept: number;
  labelsDropped: number;
  splitsKept: number;
  splitsDropped: number;
  error?: string;
  requestedBy: string;
  createdAt: string;
  finishedAt?: string;
}
