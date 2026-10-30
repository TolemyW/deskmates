// The few Slack Web API methods the plugin uses, over the injectable transport: `auth.test` and
// `bots.info` (identity), `apps.connections.open` (Socket Mode) and `chat.postMessage` (replies
// and notices). 429 is retried after Slack's `Retry-After`, a bounded number of times. Slack's
// error codes are short machine strings (`invalid_auth`, `channel_not_found`), safe to show and
// log; a token never appears in an error.

import type { SlackTransport } from "./transport.js";

/** Error codes that mean the credential no longer works: the connection is revoked. */
const REVOKED_CODES = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    /** The same call may succeed later (network failure, 429 after retries, 5xx). */
    readonly retryable: boolean,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }

  /** The token is invalid, revoked or lacks what the plugin needs. */
  get revoked(): boolean {
    return REVOKED_CODES.has(this.code);
  }
}

export interface SlackWebApiOptions {
  transport: SlackTransport;
  /** Attempts after the first on 429, 5xx or a network failure. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Longest wait for one `Retry-After`, so a misbehaving header cannot park a relay for hours. */
const RETRY_AFTER_MAX_MS = 60_000;

const realSleep = (ms: number) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });

export class SlackWebApi {
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SlackWebApiOptions) {
    this.retries = options.retries ?? 3;
    this.sleep = options.sleep ?? realSleep;
  }

  /** One method call; resolves with Slack's body when `ok`, throws `SlackApiError` otherwise. */
  async call(
    method: string,
    token: string,
    params: Readonly<Record<string, string>> = {},
  ): Promise<Record<string, unknown>> {
    let attempt = 0;
    for (;;) {
      let status = 0;
      let retryAfterMs = 1000 * 2 ** attempt;
      let body: unknown;
      try {
        const response = await this.options.transport.call(method, token, params);
        status = response.status;
        body = response.body;
        if (response.retryAfterSeconds !== undefined)
          retryAfterMs = Math.min(response.retryAfterSeconds * 1000, RETRY_AFTER_MAX_MS);
      } catch {
        status = 0;
      }
      const record =
        body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
      if (status >= 200 && status < 300 && record?.ok === true) return record;
      const code =
        typeof record?.error === "string" && /^[a-z0-9_]{1,64}$/.test(record.error)
          ? record.error
          : status === 0
            ? "network_error"
            : `http_${status}`;
      const retryable = status === 0 || status === 429 || status >= 500 || code === "ratelimited";
      if (!retryable || attempt >= this.retries) throw new SlackApiError(method, code, retryable);
      attempt += 1;
      await this.sleep(retryAfterMs);
    }
  }
}
