import type { WAMessage } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SocketCallbacks, WebSession, type WebSocketHandle } from "./session.js";

const ACCOUNT = "15550001111";
const sessions: WebSession[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
  vi.useRealTimers();
});
function setup(overrides: Partial<ConstructorParameters<typeof WebSession>[0]> = {}) {
  const callbacks: SocketCallbacks[] = [];
  const sockets: WebSocketHandle[] = [];
  const inbound = vi.fn(async () => {});
  const reset = vi.fn();
  const pause = vi.fn(async () => {});
  const onAccount = vi.fn(async () => {});
  const create = vi.fn(async (callback: SocketCallbacks) => {
    callbacks.push(callback);
    const socket = {
      end: vi.fn(),
      logout: vi.fn(async () => {}),
      send: vi.fn(async () => "out1"),
      resolveLid: vi.fn(async () => null),
    };
    sockets.push(socket);
    return socket;
  });
  const session = new WebSession({
    create,
    inbound,
    reset,
    pause,
    onAccount,
    encodeQr: async (qr) => `data:image/png;base64,${qr}`,
    isOutbound: () => false,
    retryMs: 10,
    qrLifetimeMs: 60,
    ...overrides,
  });
  sessions.push(session);
  return { session, callbacks, sockets, create, inbound, reset, pause, onAccount };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const input: WAMessage = {
  key: { remoteJid: "15550002222@s.whatsapp.net", id: "m1" },
  message: { conversation: "hi" },
};

describe("QR socket lifecycle", () => {
  it("renders the latest QR, expires it, and clears it on connection", async () => {
    const { session, callbacks } = setup();
    await session.connect();
    callbacks[0]?.update({ qr: "qr-one" });
    await flush();
    expect(session.snapshot()).toMatchObject({ phase: "qr", qr: "data:image/png;base64,qr-one" });
    await vi.advanceTimersByTimeAsync(60);
    expect(session.snapshot().qr).toBeNull();
    callbacks[0]?.update({ qr: "qr-two" });
    await flush();
    callbacks[0]?.update({ connection: "open", account: `${ACCOUNT}:1@s.whatsapp.net` });
    await flush();
    expect(session.snapshot()).toMatchObject({ phase: "connected", account: ACCOUNT, qr: null });
  });
  it("deduplicates connect actions and reconnects pairing's restart transition", async () => {
    const { session, create, callbacks, sockets } = setup();
    await Promise.all([session.connect(), session.connect()]);
    expect(create).toHaveBeenCalledTimes(1);
    callbacks[0]?.update({ connection: "close", reason: "restart" });
    await flush();
    expect(sockets[0]?.end).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    callbacks[0]?.update({ qr: "stale" });
    callbacks[0]?.messages("notify", [input]);
    await flush();
    expect(session.snapshot().qr).toBeNull();
    expect(session.snapshot().phase).toBe("connecting");
  });
  it("backoff is bounded and stop cancels a scheduled reconnect", async () => {
    const { session, callbacks, create } = setup();
    await session.connect();
    callbacks[0]?.update({ connection: "close", reason: "transient" });
    expect(session.snapshot().phase).toBe("reconnecting");
    await session.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({ phase: "idle", qr: null });
  });
  it.each(["logout", "invalid"] as const)("does not reconnect %s sessions", async (reason) => {
    const { session, callbacks, create, reset, pause } = setup();
    await session.connect();
    callbacks[0]?.update({ connection: "close", reason });
    await flush();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    expect(session.snapshot().phase).toBe("logged_out");
  });
  it("surfaces a sanitized linked-device rejection code", async () => {
    const { session, callbacks } = setup();
    await session.connect();
    callbacks[0]?.update({ connection: "close", reason: "invalid", code: 401 });
    await flush();
    expect(session.snapshot()).toMatchObject({
      phase: "logged_out",
      error: "WhatsApp rejected the linked-device handshake (401). Relink with a fresh QR.",
    });
  });
  it("logout fences old callbacks and stops relays before clearing credentials", async () => {
    const order: string[] = [];
    const { session, callbacks, reset } = setup({
      pause: async () => {
        order.push("pause");
      },
      reset: () => {
        order.push("reset");
      },
    });
    await session.connect();
    callbacks[0]?.update({ qr: "secret-qr" });
    await flush();
    await session.logout();
    callbacks[0]?.update({ qr: "stale-qr" });
    callbacks[0]?.messages("notify", [input]);
    await flush();
    expect(order).toEqual(["pause", "reset"]);
    expect(reset).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({ phase: "logged_out", qr: null });
  });
  it("logout during asynchronous socket startup closes that socket without resurrecting it", async () => {
    let finish: ((socket: WebSocketHandle) => void) | undefined;
    const socket = {
      end: vi.fn(),
      logout: vi.fn(async () => {}),
      send: vi.fn(async () => "m"),
      resolveLid: async () => null,
    };
    const { session, reset } = setup({
      create: async () =>
        new Promise<WebSocketHandle>((resolve) => {
          finish = resolve;
        }),
    });
    const connecting = session.connect();
    const loggingOut = session.logout();
    finish?.(socket);
    await connecting;
    await loggingOut;
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(session.snapshot().phase).toBe("logged_out");
  });
  it("late QR rendering cannot overwrite connected state", async () => {
    let finish: ((image: string) => void) | undefined;
    const { session, callbacks } = setup({
      encodeQr: async () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    await session.connect();
    callbacks[0]?.update({ qr: "old" });
    callbacks[0]?.update({ connection: "open", account: `${ACCOUNT}@s.whatsapp.net` });
    await flush();
    finish?.("data:image/png;base64,stale");
    await flush();
    expect(session.snapshot()).toMatchObject({ phase: "connected", qr: null });
  });
  it("ignores history sync and serializes all newly notified messages", async () => {
    const { session, callbacks, inbound } = setup();
    await session.connect();
    callbacks[0]?.update({ connection: "open", account: `${ACCOUNT}@s.whatsapp.net` });
    await flush();
    callbacks[0]?.messages("append", [input]);
    callbacks[0]?.messages("notify", [input, { ...input, key: { ...input.key, id: "m2" } }]);
    await flush();
    expect(inbound).toHaveBeenCalledTimes(2);
  });
  it("retries a Gateway outage with the original external ID", async () => {
    const received: string[] = [];
    let count = 0;
    const { session, callbacks } = setup({
      inbound: async (event) => {
        if (event.kind !== "text") return;
        received.push(event.id);
        if (count++ < 1) throw new Error("Gateway unavailable");
      },
    });
    await session.connect();
    callbacks[0]?.update({ connection: "open", account: `${ACCOUNT}@s.whatsapp.net` });
    await flush();
    callbacks[0]?.messages("notify", [input]);
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toEqual([`web:${ACCOUNT}:m1`, `web:${ACCOUNT}:m1`]);
    expect(session.snapshot().inboundFailures).toBe(0);
  });
  it("does not claim delivery without an outbound message ID", async () => {
    const { session, callbacks, sockets } = setup();
    await session.connect();
    expect(await session.send(ACCOUNT, "offline")).toMatchObject({ ok: false, retryable: true });
    callbacks[0]?.update({ connection: "open", account: `${ACCOUNT}@s.whatsapp.net` });
    await flush();
    expect(await session.send(ACCOUNT, "confirmed")).toMatchObject({ ok: true, messageId: "out1" });
    if (sockets[0]) sockets[0].send = async () => undefined;
    expect(await session.send(ACCOUNT, "unknown")).toMatchObject({ ok: false, retryable: true });
  });
});
