import { resolve } from "node:path";
import { parseAllowedSenders } from "../whatsapp/config.js";
import { whatsappProxy } from "./proxy.js";

export interface WebConfig {
  bind: string;
  port: number;
  operatorToken: string;
  gatewayUrl: string;
  workspaceId: string;
  botIds: string[];
  allowedSenders: ReadonlySet<string>;
  dataDir: string;
  proxyUrl: string | undefined;
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const operatorToken = required("GATEWAY_OPERATOR_TOKEN");
  if (Buffer.byteLength(operatorToken) < 32)
    throw new Error("Operator token needs at least 32 bytes");
  const gatewayUrl = required("WHATSAPP_GATEWAY_URL");
  const url = new URL(gatewayUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("WHATSAPP_GATEWAY_URL must be an HTTP(S) URL without credentials");
  }
  const botIds = required("WHATSAPP_BOT_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (botIds.length < 1 || botIds.length > 6) throw new Error("Select one to six bot IDs");
  const port = Number(env.WHATSAPP_WEB_PORT ?? "8091");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid WhatsApp Web port");
  return {
    bind: env.WHATSAPP_WEB_BIND?.trim() || "127.0.0.1",
    port,
    operatorToken,
    gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
    workspaceId: required("WHATSAPP_WORKSPACE_ID"),
    botIds,
    allowedSenders: parseAllowedSenders(env.WHATSAPP_ALLOWED_SENDERS),
    dataDir: resolve(env.WHATSAPP_WEB_DATA_DIR?.trim() || "./data/whatsapp-web"),
    proxyUrl: whatsappProxy(env),
  };
}
