// Activity summaries (ADR-0033): the counted bound shared by the sidecar job, the Gateway store
// and the web card, plus the record the Activity API returns.

import type { RunId } from "./ids.js";

/** Decision 3: CJK text is bounded in grapheme clusters, other text in words, both in lines. */
export const ACTIVITY_SUMMARY_MAX_CJK = 50;
export const ACTIVITY_SUMMARY_MAX_WORDS = 30;
export const ACTIVITY_SUMMARY_MAX_LINES = 3;
/** Decision 6: the job's source is cut here before it is wrapped as untrusted data. */
export const ACTIVITY_SUMMARY_SOURCE_MAX = 4000;
/**
 * The job's output token cap. Decision 3 bounds the reply, not this: the cap leaves room for
 * thinking, which upstreams that think by default do even when the SDK is asked for
 * `thinking: disabled` (it omits the key on the wire). At 256, a cheap model's ~300 tokens of
 * thinking used the whole cap before any text (probe 2026-10-26).
 */
export const ACTIVITY_SUMMARY_MAX_OUTPUT_TOKENS = 1024;
/** Decision 5: at most this many source versions of one run are ever summarized. */
export const ACTIVITY_SUMMARY_MAX_VERSIONS = 3;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ELLIPSIS = "…";

export type ActivitySummaryStatus = "pending" | "ready" | "failed";

/** One cached summary of one source version of a run (decision 5). */
export interface ActivitySummary {
  runId: RunId;
  sourceVersion: string;
  status: ActivitySummaryStatus;
  text?: string;
  /** The recorded job that produced it; absent for a source shown verbatim. */
  summaryRunId?: RunId;
  /** True when the source already fit the bound and is shown as written, with no job. */
  verbatim?: boolean;
}

function graphemes(text: string): string[] {
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: "grapheme" },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(
    new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (s) => s.segment,
  );
}

export function isCjkText(text: string): boolean {
  return CJK.test(text);
}

/** Lines first: at most three non-empty lines, each trimmed. */
function boundLines(text: string): { text: string; cut: boolean } {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    text: lines.slice(0, ACTIVITY_SUMMARY_MAX_LINES).join("\n"),
    cut: lines.length > ACTIVITY_SUMMARY_MAX_LINES,
  };
}

/** Whether `text` already fits decision 3's bound unchanged. */
export function fitsActivitySummary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return boundActivitySummary(trimmed) === boundLines(trimmed).text && !boundLines(trimmed).cut;
}

/**
 * Decision 3. CJK text: at most 50 non-whitespace grapheme clusters (an emoji is one). Other text:
 * at most 30 whitespace-separated words. Both: at most three lines. A cut ends in "…", which counts
 * toward the bound.
 */
export function boundActivitySummary(text: string): string {
  const lined = boundLines(text);
  let body = lined.text;
  let cut = lined.cut;
  if (isCjkText(body)) {
    const out: string[] = [];
    let counted = 0;
    const parts = graphemes(body);
    for (const [index, part] of parts.entries()) {
      const visible = part.trim().length > 0;
      if (visible && counted === ACTIVITY_SUMMARY_MAX_CJK) {
        cut = true;
        break;
      }
      if (visible) counted++;
      out.push(part);
      if (index === parts.length - 1) break;
    }
    body = out.join("");
    if (cut) {
      // Make room for the ellipsis inside the bound.
      const kept = graphemes(body);
      while (kept.length > 0 && kept.filter((p) => p.trim()).length >= ACTIVITY_SUMMARY_MAX_CJK)
        kept.pop();
      body = `${kept.join("").trimEnd()}${ELLIPSIS}`;
    }
    return body;
  }
  const tokens = body.split(/(\s+)/);
  let words = 0;
  const out: string[] = [];
  for (const token of tokens) {
    if (token.trim().length === 0) {
      out.push(token);
      continue;
    }
    if (words === ACTIVITY_SUMMARY_MAX_WORDS) {
      cut = true;
      break;
    }
    words++;
    out.push(token);
  }
  body = out.join("").trimEnd();
  return cut ? `${body}${ELLIPSIS}` : body;
}
