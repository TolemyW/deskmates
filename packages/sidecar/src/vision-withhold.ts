// ADR-0023 amendment 2, decision 12 (issue #87): when the run's model cannot see images, the
// sidecar gives it a text notice wherever it would have been given an image. A model that is
// handed an image it cannot see does not say so; it invents a description. A notice it can read
// leaves it nothing to invent from, and the prompt tells it to say it cannot view the image.
//
// This module holds the fixed texts and the one rule for which `Read` calls produce an image; the
// PreToolUse hook, the context builder and the browser MCP proxy apply them.

import type { StartRunRequest } from "@deskmates/contracts";
import type { EventSink } from "./ledger.js";
import { deskmatesToolName } from "./risk-tier.js";

/** Set on the browser MCP proxy's environment for a withholding run (`browser-mcp.ts`). */
export const VISION_POLICY_ENV = "DESKMATES_VISION_POLICY";

/** Extensions the SDK's `Read` returns as an image block. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

export function withholdsImages(request: Pick<StartRunRequest, "visionPolicy">): boolean {
  return request.visionPolicy === "withhold";
}

/** Whether `Read` of this path would hand the model an image block. */
export function isImagePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The system prompt section of a withholding run. Absent otherwise, so other prompts are unchanged. */
export const VISION_WITHHELD_GUIDANCE = [
  "## Images",
  "The model running this conversation cannot see images (Deskmates vision check). Image files, screenshots and other image content are not shown to you; a tool that would return an image returns a short notice instead.",
  "Never describe, transcribe, count, compare or judge the content of an image, a screenshot or a slide. When a task needs that, say plainly that you cannot view images, and use text sources instead: page snapshots, file text, alt text, metadata, or a person who can look.",
].join("\n");

/** The deny reason the PreToolUse hook returns for an image `Read`. */
export function imageReadNotice(path: string): string {
  return `image_withheld: ${path} is an image and this run's model cannot see images, so it was not read. Do not guess its content; say you cannot view it, or use a text source.`;
}

/** What replaces an `image` item of a browser tool result. */
export function withheldImageText(mimeType: unknown): string {
  const media = typeof mimeType === "string" && mimeType !== "" ? ` (${mimeType})` : "";
  return `[Deskmates: an image${media} was withheld because this run's model cannot see images. Its content is unknown to you; do not describe it.]`;
}

/** Replace every `image` item of an MCP tool result with its notice; other items stay put. */
export function withholdResultImages(result: unknown): unknown {
  return withholdToolResult(result).result;
}

/**
 * `withholdResultImages` plus what it replaced: the media type of each withheld item (`image`
 * when the item named none), so the caller can record the withholding (amendment 3, decision 17).
 */
export function withholdToolResult(result: unknown): { result: unknown; withheld: string[] } {
  const withheld: string[] = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) return { result, withheld };
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return { result, withheld };
  const content = record.content.map((item: unknown) => {
    if (!item || typeof item !== "object") return item;
    const block = item as Record<string, unknown>;
    if (block.type !== "image") return item;
    withheld.push(mediaOf(block.mimeType));
    return { type: "text", text: withheldImageText(block.mimeType) };
  });
  return withheld.length > 0 ? { result: { ...record, content }, withheld } : { result, withheld };
}

// ADR-0023 amendment 3 (issue #87): PDF reads and connector or integration values.

/** The ledger record of one cleaned tool result (decision 17): tool, count and media types. */
function recordWithheld(sink: EventSink, toolName: string, withheld: string[]): void {
  if (withheld.length === 0) return;
  sink.emit("log", {
    source: "vision",
    op: "image_withheld",
    toolName,
    count: withheld.length,
    media: [...new Set(withheld)].sort(),
  });
}

/**
 * A connector or integration value as the model may see it (decision 16): unchanged when the run
 * delivers images, else with every embedded image replaced by the notice and the withholding
 * recorded. The Gateway's own `tool_result` keeps the raw value.
 */
export function valueForModel(
  request: Pick<StartRunRequest, "visionPolicy">,
  sink: EventSink,
  toolName: string,
  value: unknown,
): unknown {
  if (!withholdsImages(request)) return value;
  const cleaned = withholdValueImages(value);
  recordWithheld(sink, toolName, cleaned.withheld);
  return cleaned.value;
}

/**
 * Every tool on the in-process `deskmates` server, with its results stripped of image items on a
 * withholding run (decision 16). A delivering run gets the tools back unchanged.
 */
export function withholdingToolResults<T extends { name: string; handler: unknown }>(
  request: Pick<StartRunRequest, "visionPolicy">,
  sink: EventSink,
  tools: T[],
): T[] {
  if (!withholdsImages(request)) return tools;
  return tools.map((tool) => {
    const handler = tool.handler as (...args: unknown[]) => Promise<unknown>;
    const wrapped = async (...args: unknown[]) => {
      const cleaned = withholdToolResult(await handler(...args));
      recordWithheld(sink, deskmatesToolName(tool.name), cleaned.withheld);
      return cleaned.result;
    };
    return { ...tool, handler: wrapped };
  });
}

/** Whether `Read` of this path would hand the model a PDF, whose pages a model reads as images. */
export function isPdfPath(path: unknown): path is string {
  return typeof path === "string" && path.toLowerCase().endsWith(".pdf");
}

/** The deny reason the PreToolUse hook returns for a PDF `Read` on a withholding run. */
export function pdfReadNotice(path: string): string {
  return `image_withheld: ${path} is a PDF, whose pages reach the model as images, and this run's model cannot see images, so it was not read. Do not guess its content; say you cannot view it, or use a text source such as an accompanying text file or a person.`;
}

function mediaOf(mimeType: unknown): string {
  return typeof mimeType === "string" && mimeType !== "" ? mimeType : "image";
}

const DATA_IMAGE_URI = /^data:(image\/[\w.+-]+)[;,]/i;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
/** Shortest base64 string judged by its header: shorter strings are ids and hashes, not images. */
const BASE64_IMAGE_MIN_CHARS = 64;

/** The media type of a base64 string whose bytes begin with a PNG, JPEG, GIF or WebP header. */
function base64ImageType(text: string): string | undefined {
  if (text.length < BASE64_IMAGE_MIN_CHARS || !BASE64_TEXT.test(text)) return undefined;
  const head = Buffer.from(text.slice(0, 24), "base64");
  const ascii = head.toString("latin1");
  if (head[0] === 0x89 && ascii.slice(1, 8) === "PNG\r\n\u001a\n") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** The media type of a string that is an image, or undefined for any other string. */
function stringImageType(text: string): string | undefined {
  return DATA_IMAGE_URI.exec(text)?.[1]?.toLowerCase() ?? base64ImageType(text);
}

/**
 * Replace every image a JSON value carries with the notice text (amendment 3, decision 16): an
 * object whose `type` is `image`, a `data:image/...` URI, and a base64 string whose bytes begin
 * with an image header. A link to an image is text and stays. The input is not modified; an
 * unchanged value is returned as the same reference.
 */
export function withholdValueImages(value: unknown): { value: unknown; withheld: string[] } {
  const withheld: string[] = [];
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const media = stringImageType(v);
      if (media === undefined) return v;
      withheld.push(media);
      return withheldImageText(media);
    }
    // Gateway JSON is shallow; a pathological depth is left as it is rather than recursed into.
    if (!v || typeof v !== "object" || depth > 64) return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((item) => {
        const next = walk(item, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : v;
    }
    const record = v as Record<string, unknown>;
    if (record.type === "image") {
      const source = record.source as Record<string, unknown> | undefined;
      const media = mediaOf(record.mimeType ?? record.mediaType ?? source?.media_type);
      withheld.push(media);
      return withheldImageText(media === "image" ? undefined : media);
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const next = walk(item, depth + 1);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : v;
  };
  return { value: walk(value, 0), withheld };
}
