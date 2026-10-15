// What the model proxy reads from a request body for `model_requests` (M3 context plan, Phase 1):
// the model, whether it streams, and a sha256 of the `system` field. The system text never leaves
// this function; only its hash is stored, which is enough to tell whether a resumed session sends
// the current system prompt or a snapshot of its first one (plan problem 1).
//
// ADR-0023 amendment 5 adds the request's shape: how many `cache_control` markers it carries
// anywhere, the system prompt split into the prefix it marks cacheable and the rest (one hash
// each, and a short hash per block), and the sizes of the system prompt, the tool list and the
// message list. Counts and hashes only, never text.

import { createHash } from "node:crypto";

export interface RequestFacts {
  model?: string;
  stream: boolean;
  systemSha256?: string;
  /**
   * `image` blocks anywhere in `messages`, tool results included (ADR-0023 amendment 1, decision
   * 4); absent when the body could not be read, so unknown is never recorded as zero.
   */
  imageBlocks?: number;
  /** ADR-0023 amendment 5; absent when the body could not be read. */
  shape?: RequestShape;
}

/**
 * The shape of one request (ADR-0023 amendment 5). "Static" is the system prefix the request
 * asks the upstream to cache: every block up to and including the last system block that carries
 * `cache_control`. "Dynamic" is every block after it; with no marker the whole system prompt is
 * dynamic. Characters are UTF-16 code units of the text, or of the JSON for tools.
 */
export interface RequestShape {
  /** `cache_control` markers in `system`, `tools` and `messages`, at any depth. */
  cacheControlBlocks: number;
  /** 1 for a string system prompt, the block count for an array, 0 when there is none. */
  systemBlocks: number;
  systemChars: number;
  systemStaticSha256?: string;
  systemDynamicSha256?: string;
  /** The first 16 hex digits of each system block's canonical sha256, in order. */
  systemBlockHashes: string[];
  toolsCount: number;
  toolsChars: number;
  messagesCount: number;
}

/** Image blocks in a message list, at any depth (a `tool_result`'s content holds blocks too). */
export function countImageBlocks(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || typeof value !== "object") return 0;
  if (Array.isArray(value))
    return value.reduce((n, item) => n + countImageBlocks(item, depth + 1), 0);
  const block = value as { type?: unknown; content?: unknown };
  if (block.type === "image") return 1;
  return countImageBlocks(block.content, depth + 1);
}

/** JSON with object keys sorted at every depth, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hex sha256 of the canonical JSON of `system`, string or block array; undefined when absent. */
export function systemSha256(system: unknown): string | undefined {
  if (system === undefined) return undefined;
  return createHash("sha256").update(canonicalJson(system), "utf8").digest("hex");
}

/** `cache_control` markers in a value, at any depth (a `tool_result`'s content holds blocks too). */
export function countCacheControl(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || typeof value !== "object") return 0;
  if (Array.isArray(value))
    return value.reduce((n, item) => n + countCacheControl(item, depth + 1), 0);
  const block = value as { cache_control?: unknown; content?: unknown };
  const own = block.cache_control !== undefined && block.cache_control !== null ? 1 : 0;
  return own + countCacheControl(block.content, depth + 1);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  const text = (block as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

function hasCacheControl(block: unknown): boolean {
  const marker = (block as { cache_control?: unknown } | null)?.cache_control;
  return marker !== undefined && marker !== null;
}

/** The request's shape (ADR-0023 amendment 5); see `RequestShape` for the definitions. */
export function requestShape(body: {
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
}): RequestShape {
  const blocks: unknown[] =
    body.system === undefined || body.system === null
      ? []
      : Array.isArray(body.system)
        ? body.system
        : [body.system];
  let lastMarked = -1;
  blocks.forEach((block, i) => {
    if (hasCacheControl(block)) lastMarked = i;
  });
  const staticBlocks = blocks.slice(0, lastMarked + 1);
  const dynamicBlocks = blocks.slice(lastMarked + 1);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    cacheControlBlocks:
      countCacheControl(blocks) + countCacheControl(tools) + countCacheControl(body.messages),
    systemBlocks: blocks.length,
    systemChars: blocks.reduce<number>((n, block) => n + blockText(block).length, 0),
    ...(staticBlocks.length > 0 ? { systemStaticSha256: sha256(canonicalJson(staticBlocks)) } : {}),
    ...(dynamicBlocks.length > 0
      ? { systemDynamicSha256: sha256(canonicalJson(dynamicBlocks)) }
      : {}),
    systemBlockHashes: blocks.map((block) => sha256(canonicalJson(block)).slice(0, 16)),
    toolsCount: tools.length,
    toolsChars: tools.length > 0 ? JSON.stringify(tools).length : 0,
    messagesCount: Array.isArray(body.messages) ? body.messages.length : 0,
  };
}

/** Never throws: a body the proxy cannot read still gets forwarded, with no facts. */
export function requestFacts(body: Buffer | undefined): RequestFacts {
  if (body === undefined || body.length === 0) return { stream: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { stream: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { stream: false };
  }
  const b = parsed as {
    model?: unknown;
    stream?: unknown;
    system?: unknown;
    tools?: unknown;
    messages?: unknown;
  };
  const facts: RequestFacts = {
    stream: b.stream === true,
    imageBlocks: countImageBlocks(b.messages),
    shape: requestShape(b),
  };
  if (typeof b.model === "string") facts.model = b.model;
  const hash = systemSha256(b.system);
  if (hash !== undefined) facts.systemSha256 = hash;
  return facts;
}
