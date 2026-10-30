// The Discord REST calls the plugin makes, and nothing else: who the token belongs to, the Gateway
// URL, sending a DM message, reading a DM channel's recent messages after a restart, and
// downloading an inbound image from Discord's CDN. The bot token travels only in the
// `Authorization` header; no error, log line or return value carries it.
//
// Rate limits: a 429 is retried after the `retry_after` Discord returns (capped), a 5xx or a network
// failure after a growing delay, a bounded number of times. Any other 4xx is permanent.

import { DISCORD_CDN_HOSTS, type DiscordTransport } from "./transport.js";

export const DISCORD_USER_AGENT = "DiscordBot (deskmates-channel, 1.0.0)";

/** A Discord REST refusal. `message` never contains the token. */
export class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    /** Discord's JSON error `code` (e.g. 50007 cannot send messages to this user). */
    readonly code: number | undefined,
    message: string,
    /** 429, 5xx or a network failure: the same request may succeed later. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DiscordHttpError";
  }
}

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DiscordUser;
  content?: string;
  type?: number;
  webhook_id?: string;
  attachments?: DiscordAttachment[];
  sticker_items?: { id: string; name: string }[];
}

export interface DiscordRestOptions {
  transport: DiscordTransport;
  token: string;
  /** Attempts after the first on 429, 5xx and network failures. */
  retries?: number;
  /** Longest wait honoured for one 429, in milliseconds. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The token as the operator pasted it, without surrounding space or a `Bot ` prefix. */
export function normalizeDiscordToken(raw: string | undefined): string {
  const token = (raw ?? "").trim().replace(/^Bot\s+/i, "");
  if (!token) throw new Error("A Discord bot token is required.");
  if (/\s/.test(token)) throw new Error("A Discord bot token has no spaces.");
  return token;
}

/** Replace any occurrence of the token, defensively, in text about to leave this module. */
export function redactToken(text: string, token: string): string {
  return token.length >= 8 ? text.split(token).join("[redacted]") : text;
}

export class DiscordRest {
  private readonly retries: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DiscordRestOptions) {
    this.retries = options.retries ?? 3;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  currentUser(): Promise<DiscordUser> {
    return this.json<DiscordUser>("GET", "/users/@me");
  }

  currentApplication(): Promise<{ id: string; name?: string; bot?: { id?: string } }> {
    return this.json("GET", "/applications/@me");
  }

  async gatewayUrl(): Promise<string> {
    const body = await this.json<{ url?: string }>("GET", "/gateway/bot");
    if (typeof body.url !== "string" || !body.url.startsWith("wss://"))
      throw new DiscordHttpError(200, undefined, "Discord returned no gateway URL", true);
    return body.url;
  }

  /** Send one message (at most 2000 characters) to a channel; returns Discord's message id. */
  async createMessage(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = { content, allowed_mentions: { parse: [] } };
    if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
    return this.json<{ id: string }>(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/messages`,
      body,
    );
  }

  /** Messages of a channel newer than `after`, oldest first (Discord answers newest first). */
  async messagesAfter(channelId: string, after: string, limit = 50): Promise<DiscordMessage[]> {
    const list = await this.json<DiscordMessage[]>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/messages?after=${encodeURIComponent(after)}&limit=${limit}`,
    );
    return Array.isArray(list) ? [...list].reverse() : [];
  }

  /**
   * Download an attachment from Discord's CDN, at most `maxBytes`. Only HTTPS URLs on Discord's
   * CDN hosts are fetched, without the token (CDN URLs carry their own signature).
   */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DiscordHttpError(0, undefined, "attachment URL is not a URL", false);
    }
    if (parsed.protocol !== "https:" || !DISCORD_CDN_HOSTS.includes(parsed.hostname))
      throw new DiscordHttpError(0, undefined, "attachment is not on Discord's CDN", false);
    const response = await this.options.transport.fetch(parsed.href, {
      headers: { "user-agent": DISCORD_USER_AGENT },
    });
    if (!response.ok)
      throw new DiscordHttpError(
        response.status,
        undefined,
        `attachment download failed (${response.status})`,
        response.status === 429 || response.status >= 500,
      );
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes)
      throw new DiscordHttpError(response.status, undefined, "attachment too large", false);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new DiscordHttpError(response.status, undefined, "attachment too large", false);
    return bytes;
  }

  private async json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const { transport, token } = this.options;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        response = await transport.fetch(`${transport.apiBase}${path}`, {
          method,
          headers: {
            authorization: `Bot ${token}`,
            "user-agent": DISCORD_USER_AGENT,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (attempt <= this.retries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new DiscordHttpError(
          0,
          undefined,
          redactToken(`Discord unreachable: ${reason}`, token),
          true,
        );
      }
      let text = "";
      try {
        text = await response.text();
      } catch {
        // The status still answers whether Discord accepted the request.
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (response.ok) return parsed as T;
      const error = (parsed ?? {}) as { code?: unknown; message?: unknown; retry_after?: unknown };
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt <= this.retries) {
        await this.sleep(this.retryDelay(response, error.retry_after, attempt));
        continue;
      }
      const code = typeof error.code === "number" ? error.code : undefined;
      const detail = typeof error.message === "string" ? `: ${error.message.slice(0, 200)}` : "";
      throw new DiscordHttpError(
        response.status,
        code,
        redactToken(
          `Discord ${method} ${path.split("?")[0]} answered ${response.status}${detail}`,
          token,
        ),
        retryable,
      );
    }
  }

  private retryDelay(response: Response, retryAfter: unknown, attempt: number): number {
    if (response.status === 429) {
      const seconds =
        typeof retryAfter === "number" ? retryAfter : Number(response.headers.get("retry-after"));
      if (Number.isFinite(seconds) && seconds >= 0)
        return Math.min(Math.ceil(seconds * 1000), this.maxRetryAfterMs);
    }
    return backoffMs(attempt);
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8_000);
}
