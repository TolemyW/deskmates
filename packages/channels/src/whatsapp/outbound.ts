// Sending text through the Graph API (ADR-0017 decision 6): chunked to WhatsApp's 4096-character
// limit, retried on 429 and 5xx a bounded number of times, and never retried on anything else.
// The access token travels in the Authorization header only.

/** WhatsApp's limit for a text message body. */
export const WHATSAPP_TEXT_MAX = 4096;

/** Split at the last newline, then the last space, before the limit; hard cut as the last resort. */
export function chunkText(text: string, max = WHATSAPP_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

export interface GraphApiTarget {
  graphBaseUrl: string;
  graphApiVersion: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface SendDeps extends GraphApiTarget {
  fetch: typeof fetch;
  /** Attempts after the first on 429/5xx. */
  retries: number;
  /** Injected in tests; defaults to real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export type SendResult =
  | { ok: true; messageId: string | undefined; attempts: number }
  | {
      ok: false;
      status: number;
      /** Meta's `error.code`, e.g. 131047 outside the 24-hour window. */
      code: number | undefined;
      message: string;
      attempts: number;
      /** Network failure, 429 or 5xx: the same send may succeed later. 4xx: it will not. */
      retryable: boolean;
    };

export function messagesUrl(target: GraphApiTarget): string {
  return `${target.graphBaseUrl}/${target.graphApiVersion}/${target.phoneNumberId}/messages`;
}

export function textMessageBody(to: string, text: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: text },
  };
}

interface GraphError {
  error?: { message?: string; code?: number };
}

interface GraphSendResponse {
  messages?: { id?: string }[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One text body (already within the limit) to one recipient. */
export async function sendText(deps: SendDeps, to: string, text: string): Promise<SendResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const url = messagesUrl(deps);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(textMessageBody(to, text)),
      });
    } catch (err) {
      if (attempts <= deps.retries) {
        await sleep(backoffMs(attempts));
        continue;
      }
      return {
        ok: false,
        status: 0,
        code: undefined,
        message: err instanceof Error ? err.message : String(err),
        attempts,
        retryable: true,
      };
    }
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      // The status already answers whether Meta accepted or refused the send. A body-stream
      // failure must not escape the retry policy: retry 429/5xx, keep other 4xx permanent, and
      // preserve an accepted 2xx with an unknown message id rather than send it again.
    }
    if (response.ok) {
      let parsed: GraphSendResponse = {};
      try {
        parsed = JSON.parse(bodyText) as GraphSendResponse;
      } catch {
        // A 2xx with an unreadable body still delivered; the id is just unknown.
      }
      return { ok: true, messageId: parsed.messages?.[0]?.id, attempts };
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempts <= deps.retries) {
      await sleep(backoffMs(attempts));
      continue;
    }
    let error: GraphError = {};
    try {
      error = JSON.parse(bodyText) as GraphError;
    } catch {
      // Not JSON; the status is the whole story.
    }
    return {
      ok: false,
      status: response.status,
      code: error.error?.code,
      message: error.error?.message ?? `HTTP ${response.status}`,
      attempts,
      retryable,
    };
  }
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}
