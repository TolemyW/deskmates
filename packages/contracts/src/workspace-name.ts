// The workspace name bound (ADR-0034 decision 1, issue #117). One counter for the Web form and the
// Gateway: the NFC form is split into extended grapheme clusters, an East Asian wide cluster (Han,
// kana, Bopomofo, Hangul, CJK punctuation, fullwidth forms, emoji) weighs two units, any other
// cluster one. A name holds at most 32 units: 32 Latin letters or 16 Han characters.

/** The largest weighted width of a workspace name. */
export const WORKSPACE_NAME_MAX_UNITS = 32;

/** `\u` escapes for a regular expression character class, from code points. */
const hex = (from: number, to: number) =>
  `\\u${from.toString(16).padStart(4, "0")}-\\u${to.toString(16).padStart(4, "0")}`;
/** CJK symbols and punctuation, fullwidth forms, fullwidth signs. */
const WIDE_RANGES = [hex(0x3000, 0x303f), hex(0xff01, 0xff60), hex(0xffe0, 0xffe6)].join("");
const WIDE = new RegExp(
  `^(?:\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Bopomofo}|\\p{Script=Hangul}|\\p{Extended_Pictographic}|\\p{Regional_Indicator}|[${WIDE_RANGES}])`,
  "u",
);
/** Control characters and the line and paragraph separators (U+2028, U+2029). */
const FORBIDDEN = new RegExp(`[\\p{Cc}${hex(0x2028, 0x2029)}]`, "u");
/** Combining marks, the zero-width joiner and variation selector 16 join the previous cluster. */
const COMBINING = new RegExp(`^[\\p{M}${hex(0x200d, 0x200d)}${hex(0xfe0f, 0xfe0f)}]$`, "u");

/** Extended grapheme clusters; without `Intl.Segmenter`, code points with marks joined. */
function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (s) => s.segment,
    );
  }
  const clusters: string[] = [];
  for (const point of text) {
    if (clusters.length > 0 && COMBINING.test(point)) clusters[clusters.length - 1] += point;
    else clusters.push(point);
  }
  return clusters;
}

/** The weight of one grapheme cluster: 2 for East Asian wide and emoji, otherwise 1. */
function weight(cluster: string): number {
  return WIDE.test(cluster) ? 2 : 1;
}

/** The weighted width of a name, counted on its NFC form. */
export function workspaceNameUnits(name: string): number {
  let units = 0;
  for (const cluster of graphemes(name.normalize("NFC"))) units += weight(cluster);
  return units;
}

/**
 * The longest prefix of `name` (by whole grapheme clusters) within `maxUnits`, for display
 * helpers and tests. Stored names are never shortened (ADR-0034 decision 2).
 */
export function clipWorkspaceName(name: string, maxUnits = WORKSPACE_NAME_MAX_UNITS): string {
  let units = 0;
  let out = "";
  for (const cluster of graphemes(name.normalize("NFC"))) {
    units += weight(cluster);
    if (units > maxUnits) break;
    out += cluster;
  }
  return out;
}

export type WorkspaceNameProblem =
  | { code: "blank" }
  | { code: "edge_whitespace" }
  | { code: "control_character" }
  | { code: "too_long"; units: number; max: number };

/** Why a new or renamed workspace name is refused, or undefined when it is acceptable. */
export function workspaceNameProblem(name: string): WorkspaceNameProblem | undefined {
  const normalized = name.normalize("NFC");
  if (normalized.trim() === "") return { code: "blank" };
  if (normalized.trim() !== normalized) return { code: "edge_whitespace" };
  if (FORBIDDEN.test(normalized)) return { code: "control_character" };
  const units = workspaceNameUnits(normalized);
  if (units > WORKSPACE_NAME_MAX_UNITS)
    return { code: "too_long", units, max: WORKSPACE_NAME_MAX_UNITS };
  return undefined;
}

/** An English sentence for a problem, for the Gateway's `validation` error. */
export function describeWorkspaceNameProblem(problem: WorkspaceNameProblem): string {
  switch (problem.code) {
    case "blank":
      return "workspace name is required";
    case "edge_whitespace":
      return "workspace name must not begin or end with whitespace";
    case "control_character":
      return "workspace name must not contain control characters or line breaks";
    case "too_long":
      return `workspace name is ${problem.units} units long; the limit is ${problem.max} (a Chinese, Japanese or Korean character or an emoji counts as 2)`;
  }
}
