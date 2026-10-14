// ADR-0023 amendment 2, decision 12 (issue #87): when the run's model cannot see images, the
// sidecar gives it a text notice wherever it would have been given an image. A model that is
// handed an image it cannot see does not say so; it invents a description. A notice it can read
// leaves it nothing to invent from, and the prompt tells it to say it cannot view the image.
//
// This module holds the fixed texts and the one rule for which `Read` calls produce an image; the
// PreToolUse hook, the context builder and the browser MCP proxy apply them.

import type { StartRunRequest } from "@deskmates/contracts";

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
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return result;
  let changed = false;
  const content = record.content.map((item: unknown) => {
    if (!item || typeof item !== "object") return item;
    const block = item as Record<string, unknown>;
    if (block.type !== "image") return item;
    changed = true;
    return { type: "text", text: withheldImageText(block.mimeType) };
  });
  return changed ? { ...record, content } : result;
}
