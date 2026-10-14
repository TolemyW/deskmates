import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { connectionPage } from "./page.js";

describe("connection page response ordering and offline state", () => {
  it("hides a previously rendered QR when the server is unreachable", async () => {
    const nodes = Object.fromEntries(
      [
        "auth",
        "panel",
        "token",
        "qr",
        "status",
        "help",
        "account",
        "connect",
        "logout",
        "lock",
        "error",
      ].map((id) => [
        id,
        {
          hidden: false,
          disabled: false,
          value: "",
          textContent: "",
          src: "",
          removeAttribute(name: string) {
            if (name === "src") this.src = "";
          },
        },
      ]),
    );
    const fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        phase: "qr",
        account: null,
        qr: "data:image/png;base64,fake",
        qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        error: null,
        inboundFailures: 0,
      }),
    }));
    const context = createContext({
      document: { getElementById: (id: string) => nodes[id] },
      fetch,
      setTimeout: () => 1,
      clearTimeout: () => {},
      AbortSignal,
      Date,
      confirm: () => true,
    });
    const script = connectionPage("test").match(/<script nonce="test">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw Error("No page script");
    runInContext(script, context);
    await runInContext("token='synthetic';poll()", context);
    expect(nodes.qr?.hidden).toBe(false);
    expect(nodes.qr?.src).toContain("base64,fake");
    fetch.mockRejectedValueOnce(new Error("offline"));
    await runInContext("poll()", context);
    expect(nodes.qr?.hidden).toBe(true);
    expect(nodes.qr?.src).toBe("");
    expect(nodes.status?.textContent).toBe("Connection unavailable");
  });
  it("a late status response cannot republish the QR after locking", async () => {
    const nodes = Object.fromEntries(
      [
        "auth",
        "panel",
        "token",
        "qr",
        "status",
        "help",
        "account",
        "connect",
        "logout",
        "lock",
        "error",
      ].map((id) => [
        id,
        {
          hidden: false,
          disabled: false,
          value: "",
          textContent: "",
          src: "",
          removeAttribute(name: string) {
            if (name === "src") this.src = "";
          },
        },
      ]),
    );
    let finish: ((value: unknown) => void) | undefined;
    const context = createContext({
      document: { getElementById: (id: string) => nodes[id] },
      fetch: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      setTimeout: () => 1,
      clearTimeout: () => {},
      AbortSignal,
      Date,
      confirm: () => true,
    });
    const script = connectionPage("test").match(/<script nonce="test">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw Error("No script");
    runInContext(script, context);
    const pending = runInContext("token='synthetic';poll()", context);
    runInContext("lock()", context);
    finish?.({
      status: 200,
      ok: true,
      json: async () => ({
        phase: "qr",
        qr: "data:image/png;base64,late",
        qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    await pending;
    expect(nodes.qr?.hidden).toBe(true);
    expect(nodes.qr?.src).toBe("");
    expect(nodes.panel?.hidden).toBe(true);
  });
});
