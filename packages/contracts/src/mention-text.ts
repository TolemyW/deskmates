// ADR-0056: mask literal regions for every mention consumer, preserving offsets/newlines.
// This is routing syntax, not a Markdown renderer. The stored message is never rewritten.
function spaces(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

function escaped(text: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

export function mentionRoutingText(body: string): string {
  let fence: { marker: string; length: number } | undefined;
  const text = body
    .split("\n")
    .map((line) => {
      if (fence) {
        if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t\\r]*$`).test(line))
          fence = undefined;
        return spaces(line);
      }
      if (/^ {0,3}>/.test(line)) return spaces(line);
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opening && !(opening[1]?.startsWith("`") && opening[2]?.includes("`"))) {
        const marker = opening[1] as string;
        fence = { marker: marker[0] as string, length: marker.length };
        return spaces(line);
      }
      return line;
    })
    .join("\n");

  // Pair equal-length inline delimiters in linear time, including multiline spans.
  const ticks = [...text.matchAll(/`+/g)].filter((match) => !escaped(text, match.index));
  const next = new Map<number, number>();
  const closing = new Map<number, number>();
  for (let i = ticks.length - 1; i >= 0; i--) {
    const size = ticks[i]?.[0].length as number;
    const j = next.get(size);
    if (j !== undefined) closing.set(i, j);
    next.set(size, i);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < ticks.length; i++) {
    const j = closing.get(i);
    if (j === undefined) continue;
    const start = ticks[i]?.index as number;
    const end = (ticks[j]?.index as number) + (ticks[j]?.[0].length as number);
    parts.push(text.slice(cursor, start), spaces(text.slice(start, end)));
    cursor = end;
    i = j;
  }
  parts.push(text.slice(cursor));
  return parts.join("").replace(/@/g, (at, offset: number) => (escaped(text, offset) ? " " : at));
}
