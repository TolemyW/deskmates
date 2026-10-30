// The Telegram Bot API over HTTPS with plain `fetch` (ADR-0047 decision 15: no SDK, so nothing goes
// through the dependency registry). Every request goes through an injectable transport, so T1
// tests run against a scripted fake server. The bot token is unavoidably part of the request path
// (`/bot<token>/<method>`); it never appears in an error, a log line or a status this module
// produces, and `redactToken` scrubs it from any text that came back from the transport.

/** Same shape as `fetch`; tests pass a fake Telegram server. */
export type TelegramTransport = (url: string, init: RequestInit) => Promise<Response>;

export const TELEGRAM_API_BASE_DEFAULT = "https://api.telegram.org";

/**
 * A bot token as BotFather issues it: the bot's numeric id, a colon, then the secret. Checked
 * before any request so an operator's paste cannot change the request path or host.
 */
const TOKEN_PATTERN = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;

export function isTelegramBotToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** Replace every occurrence of the token (and its secret half) in `text`. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  let out = text.split(token).join("<redacted>");
  const secret = token.slice(token.indexOf(":") + 1);
  if (secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** The fields of a Bot API `Message` this plugin reads; everything else is treated as media. */
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  message_thread_id?: number;
  is_topic_message?: boolean;
  [field: string]: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  [field: string]: unknown;
}

export interface TelegramFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

/** A refused or failed request. `status` 0 is a transport failure (no HTTP answer). */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    /** The Bot API's own description, token-scrubbed; safe to log. */
    readonly description: string,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(`Telegram ${method} failed (${status || "network"}): ${description}`);
    this.name = "TelegramApiError";
  }

  /** 401 (and 404 for a token the API does not know): the credential no longer works. */
  get revoked(): boolean {
    return this.status === 401 || this.status === 404;
  }

  /** 409: a webhook is set, or another client is reading this bot's updates. */
  get conflict(): boolean {
    return this.status === 409;
  }

  /** Network failures, 429 and 5xx may succeed later; other refusals will not. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

interface BotApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramBotApiOptions {
  token: string;
  transport: TelegramTransport;
  apiBaseUrl?: string;
}

export class TelegramBotApi {
  private readonly token: string;
  private readonly transport: TelegramTransport;
  private readonly base: string;

  constructor(options: TelegramBotApiOptions) {
    if (!isTelegramBotToken(options.token))
      throw new TelegramApiError(
        "token",
        400,
        "the bot token is not in BotFather's format",
        undefined,
      );
    this.token = options.token;
    this.transport = options.transport;
    this.base = (options.apiBaseUrl ?? TELEGRAM_API_BASE_DEFAULT).replace(/\/+$/, "");
  }

  async call<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramApiError(method, 0, this.scrub(error), undefined);
    }
    let envelope: BotApiEnvelope<T> = {};
    try {
      envelope = (await response.json()) as BotApiEnvelope<T>;
    } catch {
      envelope = {};
    }
    if (response.ok && envelope.ok === true && envelope.result !== undefined)
      return envelope.result;
    const status = envelope.error_code ?? (response.ok ? 502 : response.status);
    const retryAfter = envelope.parameters?.retry_after;
    throw new TelegramApiError(
      method,
      status,
      redactToken(
        String(envelope.description ?? response.statusText ?? "refused"),
        this.token,
      ).slice(0, 200),
      typeof retryAfter === "number" && retryAfter >= 0 ? retryAfter : undefined,
    );
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {}, signal);
  }

  getUpdates(
    params: { offset: number; timeoutSeconds: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        ...(params.offset > 0 ? { offset: params.offset } : {}),
        timeout: params.timeoutSeconds,
        limit: params.limit ?? 50,
        allowed_updates: ["message"],
      },
      signal,
    );
  }

  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<TelegramMessage> {
    return this.call<TelegramMessage>(
      "sendMessage",
      { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
      signal,
    );
  }

  getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", { file_id: fileId }, signal);
  }

  /** Download a file `getFile` named, refusing anything larger than `maxBytes`. */
  async download(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9._/-]{1,256}$/.test(filePath) || filePath.split("/").includes(".."))
      throw new TelegramApiError("download", 400, "unexpected file path", undefined);
    let response: Response;
    try {
      response = await this.transport(`${this.base}/file/bot${this.token}/${filePath}`, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramApiError("download", 0, this.scrub(error), undefined);
    }
    if (!response.ok)
      throw new TelegramApiError("download", response.status, "file download refused", undefined);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new TelegramApiError("download", 413, "file too large", undefined);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new TelegramApiError("download", 413, "file too large", undefined);
    return bytes;
  }

  private scrub(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return redactToken(text, this.token).slice(0, 200);
  }
}
