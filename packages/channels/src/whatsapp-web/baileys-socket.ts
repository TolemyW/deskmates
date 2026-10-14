// Vendor knowledge stays in the operator-side service, never in the Gateway or workspace.
import { DisconnectReason, generateMessageIDV2, makeWASocket } from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pino } from "pino";
import type { WebAuthStore } from "./auth-store.js";
import type { SocketCallbacks, WebSocketHandle } from "./session.js";
import { resolveWaWebVersion } from "./wa-web-version.js";

export async function createBaileysSocket(
  store: WebAuthStore,
  callbacks: SocketCallbacks,
  proxyUrl?: string,
): Promise<WebSocketHandle> {
  let alive = true;
  let ended = false;
  const version = await resolveWaWebVersion(proxyUrl);
  const socket = makeWASocket({
    auth: {
      creds: store.state.creds,
      keys: {
        get: (type, ids) => (alive ? store.state.keys.get(type, ids) : {}),
        set: async (data) => {
          if (alive) await store.state.keys.set(data);
        },
      },
    },
    logger: pino({ level: "silent" }),
    browser: ["Deskmates", "Chrome", "1.0"],
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    qrTimeout: 60_000,
    connectTimeoutMs: 30_000,
    defaultQueryTimeoutMs: 30_000,
    ...(version ? { version } : {}),
    ...(proxyUrl
      ? { agent: new HttpsProxyAgent(proxyUrl), fetchAgent: new HttpsProxyAgent(proxyUrl) }
      : {}),
  });
  socket.ev.on("creds.update", (update) => {
    if (alive) {
      try {
        store.saveCreds(update);
      } catch {
        handle.end();
        callbacks.update({ connection: "close", reason: "invalid" });
      }
    }
  });
  socket.ev.on("connection.update", (update) => {
    if (!alive) return;
    if (update.qr) callbacks.update({ qr: update.qr });
    if (update.connection === "open")
      callbacks.update({ connection: "open", account: socket.user?.id ?? "" });
    if (update.connection === "close") {
      const code = (
        update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      const reason =
        code === DisconnectReason.loggedOut
          ? "logout"
          : code === DisconnectReason.restartRequired
            ? "restart"
            : code === DisconnectReason.badSession ||
                code === DisconnectReason.connectionReplaced ||
                code === DisconnectReason.multideviceMismatch ||
                code === DisconnectReason.forbidden
              ? "invalid"
              : "transient";
      callbacks.update({ connection: "close", reason, ...(code ? { code } : {}) });
    }
  });
  socket.ev.on("messages.upsert", (event) => {
    if (alive) callbacks.messages(event.type, event.messages);
  });
  const handle: WebSocketHandle = {
    end: () => {
      if (ended) return;
      ended = true;
      alive = false;
      socket.end(undefined);
    },
    logout: async () => {
      alive = false;
      await socket.logout();
    },
    send: async (to, text) => {
      if (!alive) throw new Error("Socket stopped");
      const messageId = generateMessageIDV2(socket.user?.id);
      // Persist BEFORE sending: the self-chat echo can arrive before sendMessage resolves.
      store.rememberOutbound(messageId);
      const sent = await socket.sendMessage(`${to}@s.whatsapp.net`, { text }, { messageId });
      if (alive && sent?.key.id) store.rememberOutbound(sent.key.id);
      return sent?.key.id ?? undefined;
    },
    resolveLid: (jid) => socket.signalRepository.lidMapping.getPNForLID(jid),
  };
  return handle;
}
