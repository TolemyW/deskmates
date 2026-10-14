import { HttpsProxyAgent } from "https-proxy-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAuthStore } from "./auth-store.js";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
  makeWASocket: vi.fn(),
  resolveWaWebVersion: vi.fn(),
}));

vi.mock("@whiskeysockets/baileys", () => ({
  DisconnectReason: {
    badSession: 500,
    connectionReplaced: 440,
    forbidden: 403,
    loggedOut: 401,
    multideviceMismatch: 411,
    restartRequired: 515,
  },
  generateMessageIDV2: vi.fn(() => "message-id"),
  makeWASocket: mocks.makeWASocket,
}));

vi.mock("./wa-web-version.js", () => ({ resolveWaWebVersion: mocks.resolveWaWebVersion }));

import { createBaileysSocket } from "./baileys-socket.js";

function authStore(): WebAuthStore {
  return {
    state: {
      creds: {},
      keys: {
        get: vi.fn(() => ({})),
        set: vi.fn(async () => {}),
      },
    },
    saveCreds: vi.fn(),
    rememberOutbound: vi.fn(),
    isOutbound: vi.fn(() => false),
  } as unknown as WebAuthStore;
}

beforeEach(() => {
  mocks.listeners.clear();
  mocks.makeWASocket.mockReset();
  mocks.resolveWaWebVersion.mockReset();
  mocks.makeWASocket.mockImplementation(() => ({
    ev: {
      on: (event: string, listener: (payload: unknown) => void) => {
        mocks.listeners.set(event, listener);
      },
    },
    end: vi.fn(),
    logout: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ key: { id: "sent-id" } })),
    signalRepository: { lidMapping: { getPNForLID: vi.fn(async () => null) } },
  }));
});

describe("Baileys socket configuration", () => {
  it("passes the live WhatsApp Web version and the configured proxy to Baileys", async () => {
    mocks.resolveWaWebVersion.mockResolvedValue([2, 3000, 1049994111]);

    await createBaileysSocket(
      authStore(),
      { update: vi.fn(), messages: vi.fn() },
      "http://127.0.0.1:7890",
    );

    expect(mocks.resolveWaWebVersion).toHaveBeenCalledWith("http://127.0.0.1:7890");
    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({
        version: [2, 3000, 1049994111],
        agent: expect.any(HttpsProxyAgent),
        fetchAgent: expect.any(HttpsProxyAgent),
      }),
    );
  });

  it("uses the bundled Baileys version when live discovery fails", async () => {
    mocks.resolveWaWebVersion.mockResolvedValue(undefined);

    await createBaileysSocket(authStore(), { update: vi.fn(), messages: vi.fn() });

    const config = mocks.makeWASocket.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).not.toHaveProperty("version");
  });

  it("reports only the sanitized disconnect code to the session", async () => {
    mocks.resolveWaWebVersion.mockResolvedValue([2, 3000, 1049994111]);
    const update = vi.fn();
    await createBaileysSocket(authStore(), { update, messages: vi.fn() });

    mocks.listeners.get("connection.update")?.({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    expect(update).toHaveBeenCalledWith({ connection: "close", reason: "logout", code: 401 });
  });
});
