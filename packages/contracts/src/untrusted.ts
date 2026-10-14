// The wrapper that marks another bot's text as data, not instructions (design v0.3 §3.10;
// ADR-0005 item 9). The sidecar applies it to every delivered bot message; the Gateway applies it
// when it quotes a bot's reply inside a system notice (ADR-0016 amendment 1, decision 9). One
// implementation, so the two packages cannot drift on what a neutralised closing tag looks like.

/**
 * A forged closing tag, in every spelling a tolerant reader would accept: whitespace after `<`,
 * around the slash and before `>`.
 */
const CLOSE_TAG = /<\s*\/\s*untrusted\s*>/gi;

/** Characters that would let a source label break out of the opening tag's attribute. */
const LABEL_UNSAFE = /[<>"'\r\n]/g;

/** The opening of a wrapper around a bot's text; the sidecar's taint tracker looks for it. */
export const UNTRUSTED_BOT_MARK_PREFIX = '<untrusted source="bot:';

/**
 * Wrap `text` as untrusted content from `source`; a forged closing tag inside is neutralised.
 *
 * The body stays readable as written and only the spellings of `</untrusted>` that `CLOSE_TAG`
 * knows are rewritten. It is a blocklist, and a blocklist is only ever as wide as its author's
 * imagination; page text goes through the sidecar's entity-escaping wrappers instead.
 */
export function wrapUntrusted(source: string, text: string): string {
  const label = source.replace(LABEL_UNSAFE, "");
  const body = text.replace(CLOSE_TAG, "</untrusted-escaped>");
  return `<untrusted source="${label}">\n${body}\n</untrusted>`;
}
