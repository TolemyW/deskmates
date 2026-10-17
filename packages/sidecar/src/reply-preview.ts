// The sidecar's half of the streamed reply preview (ADR-0037 decision 7). Text deltas of the
// top-level assistant message are accumulated per content block; `decodeReplySoFar` finds the
// summary block's `"reply": "` and decodes the JSON string from there as far as it has arrived.
// Nothing outside that string is ever sent: no prose before the block, no `done`, no `learned`.
// Snapshots are cumulative and posted one at a time; the latest one waiting is sent when the
// previous post returns, so a slow Gateway coalesces frames instead of queueing them.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  REPLY_PREVIEW_MAX_CHARS,
  type ReplyPreviewRequest,
  type RunId,
} from "@deskmates/contracts";

const REPLY_KEY = /"reply"\s*:\s*"/g;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * The `reply` string decoded as far as `text` goes, or undefined while no `"reply": "` has
 * appeared. Uses the last occurrence after the last ```json fence (or anywhere when there is no
 * fence), so a key quoted in prose before the block is not taken. A partial escape at the end is
 * left for the next delta.
 */
export function decodeReplySoFar(text: string): string | undefined {
  const fence = text.lastIndexOf("```json");
  const scope = fence >= 0 ? text.slice(fence) : text;
  let start = -1;
  for (const match of scope.matchAll(REPLY_KEY)) start = (match.index ?? 0) + match[0].length;
  if (start < 0) return undefined;
  let out = "";
  for (let i = start; i < scope.length; i += 1) {
    const ch = scope[i] as string;
    if (ch === '"') return out;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = scope[i + 1];
    if (next === undefined) return out;
    if (next === "u") {
      const hex = scope.slice(i + 2, i + 6);
      if (hex.length < 4) return out;
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += SIMPLE_ESCAPES[next] ?? next;
    i += 1;
  }
  return out;
}

export interface ReplyPreviewOptions {
  runId: RunId;
  attempt: number;
  post: (request: ReplyPreviewRequest) => Promise<void>;
  redact: (text: string) => string;
}

export class ReplyPreviewer {
  private block = "";
  private sent = "";
  private seq = 0;
  private pending: string | undefined;
  private inFlight: Promise<void> | undefined;
  private failed = false;

  constructor(private readonly opts: ReplyPreviewOptions) {}

  /** Reads one SDK message; only top-level text deltas and block boundaries matter. */
  observe(msg: SDKMessage): void {
    if (this.failed || msg.type !== "stream_event" || msg.parent_tool_use_id !== null) return;
    const event = msg.event;
    if (event.type === "message_start" || event.type === "content_block_start") {
      this.block = "";
      return;
    }
    if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") return;
    this.block += event.delta.text;
    const reply = decodeReplySoFar(this.block);
    if (reply === undefined) return;
    const text = this.opts.redact(reply).slice(0, REPLY_PREVIEW_MAX_CHARS);
    if (text.trim() === "" || text === this.sent || text === this.pending) return;
    this.pending = text;
    if (!this.inFlight) this.inFlight = this.drain();
  }

  /** Waits for the frame in flight and the one waiting behind it; used before the run ends. */
  async flush(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending !== undefined && !this.failed) {
        const text = this.pending;
        this.pending = undefined;
        this.seq += 1;
        try {
          await this.opts.post({
            type: "reply_preview",
            runId: this.opts.runId,
            attempt: this.opts.attempt,
            seq: this.seq,
            text,
          });
          this.sent = text;
        } catch {
          // A preview is a courtesy: an older Gateway without the route, or one that refuses it,
          // stops previews for this attempt and changes nothing else.
          this.failed = true;
        }
      }
    } finally {
      this.inFlight = undefined;
    }
  }
}
