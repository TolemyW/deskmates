// The webhook listener (ADR-0017 decisions 5 and 8): the subscription handshake, signed POSTs,
// and a health check. Plain HTTP on a loopback bind by default; TLS is the reverse proxy's job.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AdapterLog } from "./adapter.js";
import { SIGNATURE_HEADER, verifySignature, verifyTokenMatches } from "./signature.js";

export const WEBHOOK_PATH = "/whatsapp/webhook";
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

export interface WebhookHandler {
  handleWebhook(body: unknown): Promise<{ status: 200 | 503 }>;
}

export interface ServerOptions {
  handler: WebhookHandler;
  verifyToken: string;
  appSecret: string;
  log: AdapterLog;
  path?: string;
  maxBodyBytes?: number;
}

function text(res: ServerResponse, status: number, body: string, type = "text/plain"): void {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
  res.end(body);
}

/** The whole body, or undefined once it exceeds `limit` (the rest is drained, not read). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(overflow ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createWhatsAppServer(opts: ServerOptions): Server {
  const path = opts.path ?? WEBHOOK_PATH;
  const limit = opts.maxBodyBytes ?? WEBHOOK_BODY_MAX_BYTES;
  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      opts.log.warn("webhook request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) text(res, 500, "internal error");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      text(res, 200, JSON.stringify({ ok: true }), "application/json");
      return;
    }
    if (url.pathname !== path) {
      text(res, 404, "not found");
      return;
    }
    if (req.method === "GET") {
      // Meta's subscription handshake: echo the challenge only for our verify token.
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (
        mode === "subscribe" &&
        verifyTokenMatches(token, opts.verifyToken) &&
        challenge !== null
      ) {
        text(res, 200, challenge);
      } else {
        text(res, 403, "verification failed");
      }
      return;
    }
    if (req.method !== "POST") {
      text(res, 405, "method not allowed");
      return;
    }
    const raw = await readBody(req, limit);
    if (raw === undefined) {
      text(res, 413, "payload too large");
      return;
    }
    if (!verifySignature(raw, req.headers[SIGNATURE_HEADER], opts.appSecret)) {
      opts.log.warn("rejected a webhook with a missing or wrong signature");
      text(res, 401, "invalid signature");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      text(res, 400, "body is not JSON");
      return;
    }
    const result = await opts.handler.handleWebhook(body);
    text(res, result.status, result.status === 200 ? "ok" : "gateway unavailable, retry later");
  }
}
