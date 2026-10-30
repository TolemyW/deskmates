// ADR-0053: renewal checks the exact redacted snapshot frozen before inference. This proves
// source existence and freshness, not semantic entailment; relevance remains the model's job.
import { createHash } from "node:crypto";
import type { MemoryRecheckReplyItem, ModelJobRequest } from "@deskmates/contracts";
import type { RunRecord } from "../ledger/runs.js";

type Recheck = Extract<ModelJobRequest, { kind: "memory_recheck" }>;
export interface RecheckSnapshot {
  asOf: string;
  activity: string;
  evidence: NonNullable<Recheck["evidence"]>;
}

export const evidenceHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export function recheckSnapshot(run: Pick<RunRecord, "config">): RecheckSnapshot | undefined {
  if (run.config.memoryRecheckVersion !== 2) return undefined;
  const raw = run.config.memoryRecheckSnapshot as Partial<RecheckSnapshot> | undefined;
  if (
    !raw ||
    typeof raw.asOf !== "string" ||
    typeof raw.activity !== "string" ||
    !Array.isArray(raw.evidence)
  )
    return undefined;
  return raw as RecheckSnapshot;
}

/** Whitespace folded the way a model copying a line out of a prompt tends to fold it. */
export const foldWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The sidecar shows every source through this escaping (`model-job.ts`); keep the two equal. */
const escapeMarkup = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The model reads the source through the sidecar's markup-escaped prompt, so it may quote
 * `&amp;` for `&` exactly as shown, or the original text. Either form of the frozen source
 * counts, after folding whitespace on both sides; the quote still has to be a verbatim
 * substring of one of them, so no decoding of the quote itself is ever guessed.
 */
export function quotesSource(quote: string, source: string): boolean {
  const q = foldWhitespace(quote);
  return (
    q.length > 0 &&
    (foldWhitespace(source).includes(q) || foldWhitespace(escapeMarkup(source)).includes(q))
  );
}

export function hasRenewalEvidence(
  run: Pick<RunRecord, "config">,
  note: { effectiveAt: string; lastConfirmedAt?: string },
  citation: MemoryRecheckReplyItem["evidence"],
): boolean {
  const snapshot = recheckSnapshot(run);
  if (!snapshot || !citation || citation.quote.includes("[redacted]")) return false;
  const source = snapshot.evidence.find((s) => s.id === citation.sourceId);
  if (!source || typeof source.text !== "string" || source.sha256 !== evidenceHash(source.text))
    return false;
  const since = Math.max(
    Date.parse(note.effectiveAt),
    Date.parse(note.lastConfirmedAt ?? note.effectiveAt),
  );
  const at = Date.parse(source.at);
  const asOf = Date.parse(snapshot.asOf);
  return (
    Number.isFinite(since) &&
    Number.isFinite(at) &&
    Number.isFinite(asOf) &&
    at > since &&
    at <= asOf &&
    quotesSource(citation.quote, source.text)
  );
}
