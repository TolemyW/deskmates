// In-process fake of the look/OCR, speech and image generation services the operation proxy
// forwards to (ADR-0040 and amendment B), served through a `fetch` function so a T1 Gateway calls
// it with no socket. It answers the Anthropic Messages, OpenAI chat, OpenAI transcription and
// OpenAI image generations routes, records every request it received, and lets a test script the
// next answers, including failures.

export interface FakeOperationRequest {
  url: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body of a Messages or chat request. */
  json?: Record<string, unknown>;
  /** Text fields of a multipart transcription request. */
  fields?: Record<string, string>;
  /** The uploaded file of a transcription request. */
  file?: { name: string; type: string; bytes: Buffer };
}

/** A scripted answer: a body and status, a thrown network error, or a hang until aborted. */
export type FakeOperationReply =
  | { status?: number; body: unknown }
  | { raw: string; status?: number }
  | { error: "network" }
  | { error: "hang" };

export interface FakeOperationUpstreamOptions {
  /** Default `http://fake-operations.test`; any other origin is 404. */
  baseUrl?: string;
  /** Default text of a look answer. */
  lookText?: string;
  /** Default transcript, language and duration of a transcription answer. */
  transcript?: { text: string; language?: string; duration?: number };
}

/**
 * A PNG signature and IHDR chunk of the given size, padded: enough for a sniffer and a header
 * reader, not a decodable picture (ADR-0040 amendment B fixtures).
 */
export function fakePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 6, 0, 0, 0], 16);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeOperationUpstream {
  readonly baseUrl: string;
  readonly requests: FakeOperationRequest[] = [];
  private readonly queue: FakeOperationReply[] = [];
  private readonly lookText: string;
  private readonly transcript: { text: string; language?: string; duration?: number };

  constructor(opts: FakeOperationUpstreamOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://fake-operations.test").replace(/\/+$/, "");
    this.lookText = opts.lookText ?? "INVOICE 4711\nTotal: 12.00";
    this.transcript = opts.transcript ?? { text: "hello world", language: "en", duration: 3.5 };
  }

  /** Queue the answer of the next request; unqueued requests get the default answer. */
  next(reply: FakeOperationReply): this {
    this.queue.push(reply);
    return this;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    if (`${parsed.protocol}//${parsed.host}` !== new URL(this.baseUrl).origin)
      return json({ error: "unknown origin" }, 404);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const record: FakeOperationRequest = { url, path: parsed.pathname, headers };
    const body = init?.body;
    if (body instanceof FormData) {
      record.fields = {};
      for (const [key, value] of body.entries()) {
        if (typeof value === "string") record.fields[key] = value;
        else
          record.file = {
            name: value.name,
            type: value.type,
            bytes: Buffer.from(await value.arrayBuffer()),
          };
      }
    } else if (typeof body === "string") {
      record.json = JSON.parse(body) as Record<string, unknown>;
    }
    this.requests.push(record);

    const scripted = this.queue.shift();
    if (scripted && "error" in scripted) {
      if (scripted.error === "network") throw new TypeError("fetch failed");
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (scripted && "raw" in scripted)
      return new Response(scripted.raw, { status: scripted.status ?? 200 });
    if (scripted) return json(scripted.body, scripted.status ?? 200);
    return this.defaultAnswer(record);
  };

  private defaultAnswer(request: FakeOperationRequest): Response {
    if (request.path.endsWith("/v1/messages"))
      return json({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: request.json?.model,
        content: [{ type: "text", text: this.lookText }],
        usage: { input_tokens: 812, output_tokens: 14 },
      });
    if (request.path.endsWith("/v1/chat/completions"))
      return json({
        id: "chatcmpl_fake",
        model: request.json?.model,
        choices: [{ index: 0, message: { role: "assistant", content: this.lookText } }],
        usage: { prompt_tokens: 812, completion_tokens: 14 },
      });
    if (request.path.endsWith("/v1/images/generations")) {
      const n = typeof request.json?.n === "number" ? request.json.n : 1;
      const [w, h] = String(request.json?.size ?? "1024x1024")
        .split("x")
        .map(Number);
      return json({
        created: 0,
        data: Array.from({ length: n }, () => ({
          b64_json: fakePng(w ?? 1024, h ?? 1024).toString("base64"),
        })),
      });
    }
    if (request.path.endsWith("/v1/audio/transcriptions"))
      return json({
        text: this.transcript.text,
        ...(this.transcript.language ? { language: this.transcript.language } : {}),
        ...(this.transcript.duration === undefined ? {} : { duration: this.transcript.duration }),
      });
    return json({ error: "unknown route" }, 404);
  }
}
