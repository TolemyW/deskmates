// Text in both directions. Slack sends message text with `&`, `<` and `>` escaped and with its own
// markup for links and mentions (`<https://x|label>`, `<@U123>`, `<!here>`); the transcript gets
// plain text. Outbound text is escaped the same way, so a reply cannot produce a link, a user
// mention or `@channel`, then cut into chunks under Slack's recommended message length without
// splitting an entity.

/** Slack truncates a message past 40,000 characters and recommends at most 4,000. */
export const SLACK_TEXT_MAX = 4000;

function unescapeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Slack message text as a person would read it. */
export function slackTextToPlain(text: string): string {
  const plain = text.replace(/<([^<>]*)>/g, (_whole, inner: string) => {
    const [target = "", label] = inner.split("|", 2);
    if (target.startsWith("@") || target.startsWith("#"))
      return label ? `${target[0]}${label}` : target;
    if (target.startsWith("!")) {
      const name = target.slice(1).split("^")[0] ?? "";
      return label ?? `@${name}`;
    }
    return label && label !== target ? `${label} (${target})` : target;
  });
  return unescapeEntities(plain);
}

/** Escape the three characters Slack treats as control characters in message text. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Move a cut left so it does not fall inside `&amp;`, `&lt;` or `&gt;`. */
function safeCut(text: string, cut: number): number {
  const amp = text.lastIndexOf("&", cut - 1);
  if (amp >= 0 && cut - amp < 5) {
    const semicolon = text.indexOf(";", amp);
    if (semicolon >= cut) return amp;
  }
  return cut;
}

/**
 * Split already-escaped text at the last newline, then the last space, before `max`; a hard cut as
 * the last resort, never inside an entity. Always at least one chunk.
 */
export function chunkSlackText(text: string, max = SLACK_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    cut = safeCut(rest, cut);
    if (cut <= 0) cut = max;
    const head = rest.slice(0, cut).trimEnd();
    if (head) out.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}
