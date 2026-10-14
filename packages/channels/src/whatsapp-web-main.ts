#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebAuthStore } from "./whatsapp-web/auth-store.js";
import { createBaileysSocket } from "./whatsapp-web/baileys-socket.js";
import { loadWebConfig } from "./whatsapp-web/config.js";
import { createWebServer } from "./whatsapp-web/server.js";
import { WebSession } from "./whatsapp-web/session.js";
import { WhatsAppAdapter } from "./whatsapp/adapter.js";
import { GatewayClient } from "./whatsapp/gateway-client.js";
import { FileStateStore } from "./whatsapp/state.js";

export async function main(): Promise<void> {
  const config = loadWebConfig();
  const store = new WebAuthStore(config.dataDir);
  const gateway = new GatewayClient({
    baseUrl: config.gatewayUrl,
    operatorToken: config.operatorToken,
  });
  // Never log vendor error objects, message content, tokens, QR material or auth snapshots.
  const log = {
    info: (message: string, data?: Record<string, unknown>) =>
      console.log(JSON.stringify({ level: "info", message, ...data })),
    warn: (message: string, _data?: Record<string, unknown>) =>
      console.warn(JSON.stringify({ level: "warn", message })),
  };
  let relay: WhatsAppAdapter | undefined;
  let account: string | undefined;
  const session = new WebSession({
    create: async (callbacks) => createBaileysSocket(store, callbacks, config.proxyUrl),
    encodeQr: (qr) => QRCode.toDataURL(qr, { errorCorrectionLevel: "M", width: 320, margin: 4 }),
    isOutbound: (id) => store.isOutbound(id),
    reset: () => store.reset(),
    pause: async () => {
      await relay?.stop();
      relay = undefined;
      account = undefined;
    },
    onAccount: async (number) => {
      if (account === number && relay) return;
      await relay?.stop();
      account = number;
      relay = new WhatsAppAdapter({
        config: {
          phoneNumberId: `web:${number}`,
          allowedSenders: config.allowedSenders,
          workspaceId: config.workspaceId,
          botIds: config.botIds,
        },
        gateway,
        state: new FileStateStore(join(config.dataDir, `relay-${number}.json`)),
        send: (to, text) => session.send(to, text),
        log,
      });
      relay.start();
    },
    inbound: async (event) => {
      if (!relay) throw new Error("Relay unavailable");
      await relay.handleInbound(event);
    },
  });
  const server = createWebServer(session, config.operatorToken);
  try {
    await new Promise<void>((ready, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.bind, ready);
    });
  } catch (error) {
    store.close();
    throw error;
  }
  log.info("WhatsApp connection page ready", { bind: config.bind, port: config.port });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close();
    void session.stop().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (store.state.creds.registered) await session.connect();
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("WhatsApp service failed; check configuration and session directory");
    process.exit(1);
  });
}
