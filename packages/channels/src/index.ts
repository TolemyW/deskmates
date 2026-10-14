#!/usr/bin/env node
// @deskmates/channels entry point: the `deskmates-whatsapp` adapter (ADR-0017) and its building
// blocks. Imports nothing but contracts; talks to the Gateway over its operator API.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WhatsAppAdapter } from "./whatsapp/adapter.js";
import { loadWhatsAppConfig } from "./whatsapp/config.js";
import { GatewayClient } from "./whatsapp/gateway-client.js";
import { createWhatsAppServer } from "./whatsapp/server.js";
import { FileStateStore } from "./whatsapp/state.js";

export {
  WhatsAppAdapter,
  type AdapterLog,
  type WhatsAppAdapterOptions,
} from "./whatsapp/adapter.js";
export { approvalInstruction, parseApprovalCommand } from "./whatsapp/commands.js";
export { loadWhatsAppConfig, parseAllowedSenders, type WhatsAppConfig } from "./whatsapp/config.js";
export { GatewayClient, GatewayRejected, GatewayUnavailable } from "./whatsapp/gateway-client.js";
export { chunkText, sendText, WHATSAPP_TEXT_MAX } from "./whatsapp/outbound.js";
export { createWhatsAppServer, WEBHOOK_PATH } from "./whatsapp/server.js";
export { signBody, verifySignature } from "./whatsapp/signature.js";
export { FileStateStore, MemoryStateStore, type StateStore } from "./whatsapp/state.js";
export { parseWebhookPayload, type InboundEvent } from "./whatsapp/webhook-payload.js";

export async function main(): Promise<void> {
  const config = loadWhatsAppConfig(process.env);
  const log = {
    info: (message: string, data?: Record<string, unknown>) =>
      console.log(JSON.stringify({ level: "info", message, ...(data ?? {}) })),
    warn: (message: string, data?: Record<string, unknown>) =>
      console.warn(JSON.stringify({ level: "warn", message, ...(data ?? {}) })),
  };
  const adapter = new WhatsAppAdapter({
    config,
    gateway: new GatewayClient({ baseUrl: config.gatewayUrl, operatorToken: config.operatorToken }),
    state: new FileStateStore(config.stateFile),
    fetch: (input, init) => fetch(input, init),
    log,
  });
  const server = createWhatsAppServer({
    handler: adapter,
    verifyToken: config.verifyToken,
    appSecret: config.appSecret,
    log,
  });
  await new Promise<void>((ready) => server.listen(config.port, config.bind, ready));
  adapter.start();
  log.info("deskmates-whatsapp listening", {
    bind: config.bind,
    port: config.port,
    phoneNumberId: config.phoneNumberId,
    allowedSenders: config.allowedSenders.size,
    bots: config.botIds.length,
  });
  const shutdown = (): void => {
    server.close();
    adapter.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function invokedDirectly(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
