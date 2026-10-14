// Local search over the bundled manual (issue #28): titles and body text of the manifest pages,
// in the browser. No model call, no remote index.

import type { GuideEntry } from "./guide-manifest.js";

export interface GuideHit {
  entry: GuideEntry;
  /** Whether every query word is in the title. */
  inTitle: boolean;
  /** Body text around the first match, or the page's opening text for a title match. */
  snippet: string;
}

/** The words of a page with its Markdown syntax and link targets removed. */
export function guidePlainText(source: string): string {
  return source
    .replace(/^\s*```.*$/gm, " ")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?\s*:?-{2,}[-:| ]*$/gm, " ")
    .replace(/[`*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const plain = new WeakMap<GuideEntry, string>();

function plainOf(entry: GuideEntry): string {
  let text = plain.get(entry);
  if (text === undefined) {
    // The title is the first heading; search and snippets cover the rest of the page.
    text = guidePlainText(entry.source.replace(/^#\s+.*$/m, ""));
    plain.set(entry, text);
  }
  return text;
}

const SNIPPET_BEFORE = 50;
const SNIPPET_LENGTH = 160;

function snippetAt(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Pages whose title or body has every word of the query; title matches first. */
export function searchGuide(query: string, entries: readonly GuideEntry[]): GuideHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: (GuideHit & { count: number })[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const body = plainOf(entry);
    const lower = body.toLowerCase();
    const haystack = `${title} ${lower}`;
    if (!words.every((word) => haystack.includes(word))) continue;
    const inTitle = words.every((word) => title.includes(word));
    const first = Math.min(
      ...words.map((word) => lower.indexOf(word)).filter((index) => index !== -1),
    );
    const count = words.reduce((sum, word) => sum + lower.split(word).length - 1, 0);
    hits.push({
      entry,
      inTitle,
      snippet: snippetAt(body, Number.isFinite(first) ? first : 0),
      count,
    });
  }
  // Title matches first, then the pages that mention the words most often.
  return hits
    .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.count - a.count)
    .map(({ count: _count, ...hit }) => hit);
}
