// The text the ledger keeps for an SDK `tool_result` (ADR-0023 amendment 1, decision 4). Text
// blocks are joined as before. An image block used to vanish, so a `Read` of a PNG was recorded as
// an empty string and nobody could tell an image had been returned at all (issue #87); it is now a
// one-line placeholder with its media type and decoded size. The image bytes never enter the
// ledger: what the model received is the SDK's business, what the ledger proves is that it was sent.

function imagePlaceholder(block: Record<string, unknown>): string {
  const source = block.source;
  if (source && typeof source === "object") {
    const s = source as { type?: unknown; media_type?: unknown; data?: unknown };
    const media = typeof s.media_type === "string" ? s.media_type : "unknown type";
    if (typeof s.data === "string") {
      const padding = s.data.endsWith("==") ? 2 : s.data.endsWith("=") ? 1 : 0;
      const bytes = Math.max(0, Math.floor((s.data.length * 3) / 4) - padding);
      return `[image: ${media}, ${bytes} bytes]`;
    }
    return `[image: ${media}]`;
  }
  return "[image]";
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const block = b as Record<string, unknown>;
      if (typeof block.text === "string") return block.text;
      if (block.type === "image") return imagePlaceholder(block);
      return "";
    })
    .filter((t) => t !== "")
    .join("\n");
}
