import { describe, expect, it, vi } from "vitest";
import { WechatApi, wechatOrigin } from "./api.js";

describe("iLink transport", () => {
  it("keeps credentials out of QR status and sends bot metadata only to the pinned HTTPS origin", async () => {
    const transport = vi.fn(async () => Response.json({ ret: 0 }));
    const api = new WechatApi(transport);
    const signal = new AbortController().signal;
    await api.call("get_qrcode_status?qrcode=challenge", { signal });
    await api.call("getupdates", {
      signal,
      token: "private-token",
      body: { get_updates_buf: "cursor" },
    });
    const calls = transport.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[1].headers).not.toHaveProperty("Authorization");
    expect(calls[1]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer private-token" },
    });
    expect(JSON.parse(calls[1]?.[1].body as string)).toMatchObject({
      base_info: { bot_agent: "Deskmates/1.0.0" },
    });
  });
  it.each([
    "http://ilinkai.weixin.qq.com",
    "https://evil.example",
    "https://ilinkai.weixin.qq.com.evil.example",
    "https://127.0.0.1",
    "https://ilinkai.weixin.qq.com:444",
    "https://x@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com/path",
  ])("refuses credential destination %s", (url) => {
    expect(() => wechatOrigin(url)).toThrow();
  });
  it("accepts only the default or an iLink regional origin", () => {
    expect(wechatOrigin("https://sg.ilinkai.weixin.qq.com/")).toBe(
      "https://sg.ilinkai.weixin.qq.com",
    );
  });
  it("never exposes raw transport or provider errors", async () => {
    const signal = new AbortController().signal;
    await expect(
      new WechatApi(async () => {
        throw new Error("secret-token");
      }).call("getupdates", { signal }),
    ).rejects.toThrow("WeChat request failed (0, 0)");
    await expect(
      new WechatApi(async () => Response.json({ ret: -14, errmsg: "secret-token" })).call(
        "getupdates",
        { signal },
      ),
    ).rejects.toMatchObject({ code: -14, revoked: true });
    await expect(
      new WechatApi(async () => Response.json({ errcode: 5, ret: 0 })).call("sendmessage", {
        signal,
      }),
    ).rejects.toMatchObject({ code: 5 });
  });
  it("bounds response bodies and honors numeric rate-limit backoff", async () => {
    const signal = new AbortController().signal;
    await expect(
      new WechatApi(async () => new Response(" ".repeat(2 * 1024 * 1024 + 1))).call("getupdates", {
        signal,
      }),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      new WechatApi(
        async () => new Response("secret", { status: 429, headers: { "retry-after": "10" } }),
      ).call("getupdates", { signal }),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 10_000 });
  });
});
