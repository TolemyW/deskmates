// Native iLink wire client. Protocol reference: Tencent/openclaw-weixin docs/protocol.md.
// No OpenClaw runtime or copied adapter code. Provider bodies and transport errors are never
// included in errors: both can contain credentials, QR challenges or reply context tokens.
import { randomBytes } from "node:crypto";

export const WECHAT_API_ORIGIN = "https://ilinkai.weixin.qq.com";
export type WechatTransport = (url: string, init: RequestInit) => Promise<Response>;
export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WechatApiError(502);
  return value as JsonObject;
}

export class WechatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code = 0,
    readonly retryAfterMs = 0,
  ) {
    super(`WeChat request failed (${status}, ${code})`);
  }
  get revoked(): boolean {
    return this.status === 401 || this.status === 403 || this.code === -14;
  }
}

/** Never follow an arbitrary server URL with a bot token or QR challenge. */
export function wechatOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WechatApiError(400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(
      url.hostname === "ilinkai.weixin.qq.com" ||
      /^[a-z0-9-]+\.ilinkai\.weixin\.qq\.com$/.test(url.hostname)
    )
  )
    throw new WechatApiError(400);
  return url.origin;
}

export class WechatApi {
  constructor(private readonly transport: WechatTransport = (url, init) => fetch(url, init)) {}

  async call(
    path: string,
    input: {
      signal: AbortSignal;
      origin?: string;
      token?: string;
      body?: JsonObject;
      timeoutMs?: number;
    },
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(0x010000),
    };
    let body: string | undefined;
    if (input.body) {
      headers["Content-Type"] = "application/json";
      headers.AuthorizationType = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString(
        "base64",
      );
      body = JSON.stringify(
        input.token
          ? {
              ...input.body,
              base_info: { channel_version: "1.0.0", bot_agent: "Deskmates/1.0.0" },
            }
          : input.body,
      );
    }
    if (input.token) headers.Authorization = `Bearer ${input.token}`;
    try {
      const response = await this.transport(
        `${wechatOrigin(input.origin ?? WECHAT_API_ORIGIN)}/ilink/bot/${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 40_000)]),
        },
      );
      if (!response.ok) {
        const seconds = Number(response.headers.get("retry-after"));
        throw new WechatApiError(
          response.status,
          0,
          Number.isFinite(seconds) ? Math.min(Math.max(seconds * 1000, 0), 300_000) : 0,
        );
      }
      // Bound the wire response before parsing it, including servers that omit Content-Length.
      const reader = response.body?.getReader();
      if (!reader) throw new WechatApiError(502);
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 2 * 1024 * 1024) throw new WechatApiError(502);
          parts.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      const result = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
      for (const field of ["ret", "errcode"]) {
        if (
          result[field] !== undefined &&
          (typeof result[field] !== "number" || result[field] !== 0)
        )
          throw new WechatApiError(
            200,
            typeof result[field] === "number" ? (result[field] as number) : -1,
          );
      }
      return result;
    } catch (error) {
      if (error instanceof WechatApiError) throw error;
      throw new WechatApiError(0);
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
