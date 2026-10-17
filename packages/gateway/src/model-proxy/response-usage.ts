// Token usage read off a model response as its bytes pass through the proxy (M3 context plan,
// Phase 1). The proxy forwards every chunk unchanged; this only looks at copies.
//
// - `text/event-stream`: the Messages API reports usage on `message_start` (`message.usage`) and
//   `message_delta` (`usage`, cumulative). Lines are split as they arrive; only a line that names
//   one of those two events is parsed, and no more than one partial line is ever held.
// - `application/json`: the body is copied up to a cap and its top-level `usage` read at the end.
// - Anything else: nothing.
//
// A count never seen stays undefined, so the ledger says unknown rather than zero.
//
// The same bytes name the model that served the response (ADR-0023 decision 3): `message.model`
// on `message_start`, or the JSON body's top-level `model`. `servedModel()` returns it, or
// undefined when the response named none; it is never inferred from the request.

import { StringDecoder } from "node:string_decoder";

export interface ResponseUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** `usage.output_tokens_details.thinking_tokens` (or `reasoning_tokens`), when reported. */
  thinkingTokens?: number;
}

/** What the proxy records about a response once it has passed: usage and the served model. */
export interface ResponseFacts extends ResponseUsage {
  servedModel?: string;
}

export interface ResponseUsageOptions {
  /** Largest JSON body copied for its usage; a larger one reports nothing. */
  jsonMaxBytes?: number;
  /** Longest SSE line held while waiting for its end; a longer one is skipped. */
  sseLineMaxChars?: number;
}

const DEFAULT_JSON_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_SSE_LINE_MAX_CHARS = 1024 * 1024;

type Mode = "sse" | "json" | "none";

export class ResponseUsageObserver {
  private readonly mode: Mode;
  private readonly usage: ResponseUsage = {};
  private seen = false;
  private served: string | undefined;
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  /** Set while skipping the rest of an over-long SSE line. */
  private skipping = false;
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private overflow = false;
  private readonly jsonMaxBytes: number;
  private readonly sseLineMaxChars: number;

  constructor(contentType: string | null | undefined, opts: ResponseUsageOptions = {}) {
    const type = (contentType ?? "").toLowerCase();
    this.mode = type.includes("text/event-stream")
      ? "sse"
      : type.includes("application/json")
        ? "json"
        : "none";
    this.jsonMaxBytes = opts.jsonMaxBytes ?? DEFAULT_JSON_MAX_BYTES;
    this.sseLineMaxChars = opts.sseLineMaxChars ?? DEFAULT_SSE_LINE_MAX_CHARS;
  }

  push(chunk: Buffer): void {
    if (this.mode === "sse") this.pushSse(this.decoder.write(chunk));
    else if (this.mode === "json") this.pushJson(chunk);
  }

  /** The `model` the response named, once `finish()` has run for a JSON body; else undefined. */
  servedModel(): string | undefined {
    return this.served;
  }

  /** The usage seen, or undefined when the response reported none. */
  finish(): ResponseUsage | undefined {
    if (this.mode === "sse") {
      const rest = this.decoder.end();
      this.pushSse(`${rest}\n`);
    } else if (this.mode === "json" && !this.overflow) {
      try {
        const body = JSON.parse(Buffer.concat(this.chunks).toString("utf8")) as {
          usage?: unknown;
          model?: unknown;
        };
        this.merge(body?.usage);
        if (typeof body?.model === "string" && body.model !== "") this.served = body.model;
      } catch {
        /* Not JSON after all: no usage. */
      }
    }
    return this.seen ? { ...this.usage } : undefined;
  }

  private pushJson(chunk: Buffer): void {
    if (this.overflow) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > this.jsonMaxBytes) {
      this.overflow = true;
      this.chunks.length = 0;
      return;
    }
    this.chunks.push(Buffer.from(chunk));
  }

  private pushSse(text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) break;
      const piece = text.slice(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        this.line = "";
        continue;
      }
      this.handleLine(this.line + piece);
      this.line = "";
    }
    if (this.skipping) return;
    this.line += text.slice(start);
    if (this.line.length > this.sseLineMaxChars) {
      this.line = "";
      this.skipping = true;
    }
  }

  private handleLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return;
    // Anthropic names its usage events; an OpenAI chat chunk carries `usage` on its last chunk
    // (`stream_options.include_usage`) and `model` on every chunk (ADR-0044 decision 5).
    const anthropic = line.includes('"message_start"') || line.includes('"message_delta"');
    const openai = line.includes('"chat.completion') && line.includes('"usage"');
    if (!anthropic && !openai) return;
    let data: {
      type?: unknown;
      object?: unknown;
      model?: unknown;
      message?: { usage?: unknown; model?: unknown };
      usage?: unknown;
    };
    try {
      data = JSON.parse(line.slice(5).trim()) as typeof data;
    } catch {
      return;
    }
    if (data.type === "message_start") {
      this.merge(data.message?.usage);
      const model = data.message?.model;
      if (typeof model === "string" && model !== "") this.served = model;
    } else if (data.type === "message_delta") this.merge(data.usage);
    else if (typeof data.object === "string" && data.object.startsWith("chat.completion")) {
      this.merge(data.usage);
      if (typeof data.model === "string" && data.model !== "") this.served = data.model;
    }
  }

  private merge(raw: unknown): void {
    if (raw === null || typeof raw !== "object") return;
    const u = raw as Record<string, unknown>;
    // The Anthropic shape, then the OpenAI Chat Completions shape (ADR-0044 decision 5), where
    // `prompt_tokens` includes the cached part and `cached_tokens` sits one level down.
    const fields: [keyof ResponseUsage, string][] = [
      ["inputTokens", "input_tokens"],
      ["outputTokens", "output_tokens"],
      ["cacheReadTokens", "cache_read_input_tokens"],
      ["cacheCreateTokens", "cache_creation_input_tokens"],
      ["inputTokens", "prompt_tokens"],
      ["outputTokens", "completion_tokens"],
    ];
    for (const [to, from] of fields) {
      const v = u[from];
      if (typeof v === "number" && Number.isFinite(v)) {
        this.usage[to] = v;
        this.seen = true;
      }
    }
    const prompt = u.prompt_tokens_details;
    if (prompt !== null && typeof prompt === "object") {
      const v = (prompt as Record<string, unknown>).cached_tokens;
      if (typeof v === "number" && Number.isFinite(v)) {
        this.usage.cacheReadTokens = v;
        this.seen = true;
      }
    }
    // Thinking tokens sit one level down. The Anthropic shape is `thinking_tokens`; an
    // Anthropic-protocol gateway in front of another model may spell it `reasoning_tokens`, and
    // OpenAI reports `completion_tokens_details.reasoning_tokens`.
    const details = u.output_tokens_details ?? u.completion_tokens_details;
    if (details !== null && typeof details === "object") {
      const d = details as Record<string, unknown>;
      const v = d.thinking_tokens ?? d.reasoning_tokens;
      if (typeof v === "number" && Number.isFinite(v)) {
        this.usage.thinkingTokens = v;
        this.seen = true;
      }
    }
  }
}
