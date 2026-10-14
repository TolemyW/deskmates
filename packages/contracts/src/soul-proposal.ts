// AI-drafted SOUL proposals (issue #77, ADR-0023 amendment 1 decision 10). Generation and
// application are separate acts: a proposal is inert text until an operator confirms it, and
// confirming goes through the same version-checked SOUL write as a hand edit. SOUL text is a
// behaviour convention; nothing in a proposal grants a tool, an approval, egress or routing.

export type SoulProposalMode = "create" | "edit";
export type SoulProposalStatus = "pending" | "ready" | "failed" | "applied" | "discarded";

/** Longest instruction an operator may give: one sentence or a few keywords, not a document. */
export const SOUL_PROPOSAL_INSTRUCTION_MAX_CHARS = 2000;

export interface SoulProposal {
  id: string;
  botId: string;
  mode: SoulProposalMode;
  instruction: string;
  status: SoulProposalStatus;
  /** Version (sha256) of the SOUL the proposal was generated against. */
  baseVersion: string;
  /** The SOUL the proposal was generated against, for the comparison. */
  baseBody: string;
  /** The full proposed SOUL, present once `ready`. */
  proposedBody: string | null;
  runId: string | null;
  error: string | null;
  /** Version written by the apply, when applied. */
  appliedVersion: string | null;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

/** One targeted change: `find` must occur exactly once in the base. */
export interface SoulEdit {
  find: string;
  replace: string;
}

export type SoulEditsResult =
  | { ok: true; body: string }
  | { ok: false; error: "no_edits" | "not_found" | "ambiguous" | "overlap"; find?: string };

function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return at;
    at.push(index);
    from = index + 1;
  }
}

/**
 * Apply targeted edits to the loaded SOUL. Every `find` is located in the base (not in the
 * result of earlier edits) and must match exactly once; spans must not overlap. Text outside the
 * spans is copied byte for byte, so an edit can never rewrite what the operator did not ask for.
 * `append` adds a new section at the end, separated by one blank line.
 */
export function applySoulEdits(
  base: string,
  edits: readonly SoulEdit[],
  append?: string,
): SoulEditsResult {
  const appended = append?.trim() ?? "";
  if (edits.length === 0 && appended === "") return { ok: false, error: "no_edits" };
  const spans: { start: number; end: number; replace: string }[] = [];
  for (const edit of edits) {
    if (edit.find === "") return { ok: false, error: "not_found", find: edit.find };
    const at = occurrences(base, edit.find);
    if (at.length === 0) return { ok: false, error: "not_found", find: edit.find };
    if (at.length > 1) return { ok: false, error: "ambiguous", find: edit.find };
    const start = at[0] as number;
    spans.push({ start, end: start + edit.find.length, replace: edit.replace });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if ((spans[i] as { start: number }).start < (spans[i - 1] as { end: number }).end)
      return { ok: false, error: "overlap" };
  }
  let body = "";
  let cursor = 0;
  for (const span of spans) {
    body += base.slice(cursor, span.start) + span.replace;
    cursor = span.end;
  }
  body += base.slice(cursor);
  if (appended !== "") {
    const trimmed = body.replace(/\s+$/, "");
    body = trimmed === "" ? `${appended}\n` : `${trimmed}\n\n${appended}\n`;
  }
  return { ok: true, body };
}

/** One line of a line diff between the loaded SOUL and a proposal. */
export interface SoulDiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Line diff (longest common subsequence). Inputs are SOUL-sized, at most a few thousand lines. */
export function diffSoulLines(before: string, after: string): SoulDiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] as number[];
    const next = table[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: SoulDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (
      ((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)
    ) {
      out.push({ kind: "removed", text: a[i] as string });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] as string });
      j++;
    }
  }
  while (i < n) out.push({ kind: "removed", text: a[i++] as string });
  while (j < m) out.push({ kind: "added", text: b[j++] as string });
  return out;
}
