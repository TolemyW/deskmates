// Every byte the Slack plugin exchanges with Slack goes through this interface (ADR-0047 decision
// 11): Web API calls, file downloads and the Socket Mode WebSocket. The default implementation is
// plain `fetch` and the global `WebSocket` of Node 22, with no third-party package; T1 tests
// replace it with a scripted Slack (`testing/fake-slack.ts`). Tokens travel only in the
// Authorization header, never in a URL or a body, so nothing here can log one by accident.

/** One Web API answer: Slack's JSON body plus the HTTP facts the caller needs for retries. */
export interface SlackHttpResponse {
  status: number;
  /** Seconds from a `Retry-After` header, when Slack sent one (429). */
  retryAfterSeconds?: number;
  /** The parsed JSON body; undefined when the body was not JSON. */
  body: unknown;
}

export interface SlackDownload {
  status: number;
  /** The response's `Content-Type`, lowercased, without parameters. */
  contentType: string;
  /** The bytes, or undefined when the body was larger than `maxBytes`. */
  bytes: Uint8Array | undefined;
}

export interface SlackSocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /** Called once, when the socket is gone for whatever reason. */
  onClose(code: number): void;
}

export interface SlackSocket {
  send(text: string): void;
  close(): void;
}

export interface SlackTransport {
  /** POST `https://slack.com/api/<method>` form-encoded, with the token as a Bearer header. */
  call(
    method: string,
    token: string,
    params: Readonly<Record<string, string>>,
  ): Promise<SlackHttpResponse>;
  /** GET a file URL (`url_private_download`) with the bot token; stop reading past `maxBytes`. */
  download(url: string, token: string, maxBytes: number): Promise<SlackDownload>;
  /** Open the Socket Mode WebSocket at the one-time URL `apps.connections.open` returned. */
  openSocket(url: string, handlers: SlackSocketHandlers): SlackSocket;
}

export const SLACK_API_BASE = "https://slack.com/api/";

/** Only Slack's own file host is fetched with the bot token. */
export function isSlackFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "files.slack.com" && url.port === "";
  } catch {
    return false;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The production transport: `fetch` for HTTP, Node's global `WebSocket` for Socket Mode. */
export function createFetchTransport(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): SlackTransport {
  return {
    async call(method, token, params) {
      const response = await fetchImpl(`${SLACK_API_BASE}${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: new URLSearchParams(params).toString(),
      });
      const retryAfter = Number(response.headers.get("retry-after") ?? "");
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      return {
        status: response.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
        body,
      };
    },
    async download(url, token, maxBytes) {
      if (!isSlackFileUrl(url)) return { status: 0, contentType: "", bytes: undefined };
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "follow",
      });
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, contentType: contentType ?? "", bytes: undefined };
      }
      return {
        status: response.status,
        contentType: contentType ?? "",
        bytes: await readCapped(response, maxBytes),
      };
    },
    openSocket(url, handlers) {
      const socket = new WebSocket(url);
      let closed = false;
      const closeOnce = (code: number): void => {
        if (closed) return;
        closed = true;
        handlers.onClose(code);
      };
      socket.addEventListener("open", () => handlers.onOpen());
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") handlers.onMessage(event.data);
      });
      socket.addEventListener("close", (event) => closeOnce(event.code));
      socket.addEventListener("error", () => {
        closeOnce(1006);
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      });
      return {
        send: (text) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        },
        close: () => {
          try {
            socket.close();
          } catch {
            // Already closed.
          }
          closeOnce(1000);
        },
      };
    },
  };
}
