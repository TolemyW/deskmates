// What the model proxy reads from a request body for `model_requests` (M3 context plan, Phase 1):
// the model, whether it streams, and a sha256 of the `system` field. The system text never leaves
// this function; only its hash is stored, which is enough to tell whether a resumed session sends
// the current system prompt or a snapshot of its first one (plan problem 1).

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
  const b = parsed as { model?: unknown; stream?: unknown; system?: unknown; messages?: unknown };
  const facts: RequestFacts = {
    stream: b.stream === true,
    imageBlocks: countImageBlocks(b.messages),
  };
  if (typeof b.model === "string") facts.model = b.model;
  const hash = systemSha256(b.system);
  if (hash !== undefined) facts.systemSha256 = hash;
  return facts;
}
