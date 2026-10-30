// The one-line preview of a chat message (issue #16). The chat rail's last message and the
// private-chat handoff cards show it; the Gateway derives it from the stored body at read time and
// the web uses the same function for any preview it builds itself, so the two always agree. Stored
// bodies are never rewritten.

/** Graphemes of a chat rail preview: the last message and the latest handoff. */
export const CHAT_PREVIEW_MAX = 160;
/** Graphemes of a handoff card's excerpt in the incoming-handoffs list. */
export const HANDOFF_EXCERPT_MAX = 600;

/**
 * How much of a stored body a reader fetches to derive an excerpt of `max` graphemes: enough for a
 * fence line and whitespace that collapses, still a bounded read. A body longer than this is cut
 * before the fence is looked at, which only loses its tail.
 */
export function messageExcerptSourceChars(max: number): number {
  return Math.max(1024, max * 8);
}

// An opening fence: three or more backticks or tildes, then an optional info word (`json`).
const OPENING = /^\s*(`{3,}|~{3,})([A-Za-z0-9_+.#-]*)/;

/**
 * The body without a leading code fence: an opening fence line (```json) and its closing fence are
 * removed, and so is the one-line form ```json {…} ```. What follows the closing fence stays. A
 * fence that never closes (a cut prefix) is still removed from the front.
 */
function stripLeadingFence(body: string): string {
  const open = OPENING.exec(body);
  if (!open) return body;
  const marker = open[1] as string;
  const rest = body.slice(open[0].length);
  const lineEnd = rest.indexOf("\n");
  const sameLine = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
  if (sameLine.trim() === "") {
    // The fence has its own line: the content starts on the next one and ends at a line that
    // opens with the same marker.
    const content = lineEnd === -1 ? "" : rest.slice(lineEnd + 1);
    const close = new RegExp(`(?:^|\\n)[ \\t]*${marker[0]}{${marker.length},}`).exec(content);
    if (!close) return content;
    return `${content.slice(0, close.index)} ${content.slice(close.index + close[0].length)}`;
  }
  // The one-line form: the content ends at the next run of the same marker.
  const closing = rest.indexOf(marker);
  if (closing === -1) return rest;
  const run = /^[`~]*/.exec(rest.slice(closing))?.[0].length ?? marker.length;
  return `${rest.slice(0, closing)} ${rest.slice(closing + run)}`;
}

/**
 * Markdown presentation marks have no place in a one-line plain-text preview. This is not a
 * renderer: it deliberately handles the bounded inline forms people see in chat previews and
 * leaves their readable labels/code in place.
 */
function stripMarkdown(body: string): string {
  const escapes: string[] = [];
  const protectedBody = body.replace(/\\([\\`*_[\]{}()#+\-.!~>])/g, (_whole, mark: string) => {
    const slot = `\uE000${escapes.length}\uE001`;
    escapes.push(mark);
    return slot;
  });
  const plain = protectedBody
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2)(?=\n|$)/g, "$1$3")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, "$1")
    .replace(/(`+)([^\n]*?)\1/g, "$2")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
    .replace(/(^|[^A-Za-z0-9])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9])/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^A-Za-z0-9_])([*_])(?=\S)([^\n]*?\S)\2(?![A-Za-z0-9_])/g, "$1$3");
  return plain.replace(
    /\uE000(\d+)\uE001/g,
    (_whole, index: string) => escapes[Number(index)] ?? "",
  );
}

/** At most `max` extended grapheme clusters of `text`; without `Intl.Segmenter`, code points. */
function cutGraphemes(text: string, max: number): string {
  if (text.length <= max) return text;
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  let end = 0;
  let count = 0;
  if (Segmenter) {
    for (const part of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      if (count === max) break;
      end = part.index + part.segment.length;
      count += 1;
    }
  } else {
    for (const point of text) {
      if (count === max) break;
      end += point.length;
      count += 1;
    }
  }
  return text.slice(0, end);
}

/**
 * A message body as a one-line preview of at most `max` graphemes: Markdown presentation marks and
 * code fences removed, whitespace collapsed to single spaces, cut on a grapheme boundary so no
 * emoji or combined character is split. Pure; never adds an ellipsis.
 */
export function messageExcerpt(body: string, max: number): string {
  const limit = Math.max(0, Math.trunc(max));
  const flat = stripMarkdown(stripLeadingFence(body)).replace(/\s+/g, " ").trim();
  return cutGraphemes(flat, limit).trimEnd();
}
