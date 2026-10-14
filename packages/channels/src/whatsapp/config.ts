// Adapter configuration from the environment (ADR-0017 decision 8). Every credential stays in
// memory; nothing here is ever logged or sent to the Gateway.

import { DeskmatesError } from "@deskmates/contracts";

/** Graph API version the adapter calls; a guess to confirm against Meta's changelog (ADR-0017). */
export const GRAPH_API_VERSION_DEFAULT = "v23.0";
export const GRAPH_BASE_URL_DEFAULT = "https://graph.facebook.com";
export const WHATSAPP_PORT_DEFAULT = 8090;
export const WHATSAPP_BIND_DEFAULT = "127.0.0.1";
export const WHATSAPP_STATE_FILE_DEFAULT = "./data/whatsapp-state.json";
export const SEND_RETRIES_DEFAULT = 3;

export interface WhatsAppConfig {
  port: number;
  bind: string;
  /** Answers Meta's subscription handshake. */
  verifyToken: string;
  /** Signs every webhook body (`X-Hub-Signature-256`). */
  appSecret: string;
  /** Bearer token for the Graph API; a permanent System User token in production. */
  accessToken: string;
  /** The business number the adapter speaks for; webhooks for other numbers are dropped. */
  phoneNumberId: string;
  graphBaseUrl: string;
  graphApiVersion: string;
  /** `wa_id`s (E.164 digits, no `+`) allowed to drive the bots; deny-by-default (decision 4). */
  allowedSenders: ReadonlySet<string>;
  /** Operator listener of the Gateway and its credential (ADR-0006). */
  gatewayUrl: string;
  operatorToken: string;
  /** Where a sender's first message creates its thread (decision 3). */
  workspaceId: string;
  botIds: readonly string[];
  /** Per-thread relay cursors (decision 6). */
  stateFile: string;
  sendRetries: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new DeskmatesError("validation", `${key} is required in the environment`, { key });
  }
  return value;
}

function optionalInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new DeskmatesError("validation", `${key} must be a non-negative integer`, { key, raw });
  }
  return n;
}

function httpUrl(key: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeskmatesError("validation", `${key} is not a URL`, { key });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DeskmatesError("validation", `${key} must be http or https`, { key });
  }
  if (url.username || url.password) {
    throw new DeskmatesError("validation", `${key} must not carry credentials`, { key });
  }
  return raw.replace(/\/+$/, "");
}

const WA_ID = /^[0-9]{5,20}$/;

/** `WHATSAPP_ALLOWED_SENDERS`: comma-separated `wa_id`s. Empty means nobody may drive the bots. */
export function parseAllowedSenders(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const id = entry.trim().replace(/^\+/, "");
    if (id === "") continue;
    if (!WA_ID.test(id)) {
      throw new DeskmatesError(
        "validation",
        "WHATSAPP_ALLOWED_SENDERS entries must be E.164 digits (5 to 20), optionally with a leading +",
        { entry: entry.trim() },
      );
    }
    out.add(id);
  }
  return out;
}

export function loadWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig {
  const botIds = (env.WHATSAPP_BOT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (botIds.length === 0) {
    throw new DeskmatesError("validation", "WHATSAPP_BOT_IDS must list at least one bot id");
  }
  const version = env.WHATSAPP_GRAPH_API_VERSION?.trim() || GRAPH_API_VERSION_DEFAULT;
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new DeskmatesError("validation", "WHATSAPP_GRAPH_API_VERSION must look like v23.0", {
      raw: version,
    });
  }
  return {
    port: optionalInt(env, "WHATSAPP_PORT", WHATSAPP_PORT_DEFAULT),
    bind: env.WHATSAPP_BIND?.trim() || WHATSAPP_BIND_DEFAULT,
    verifyToken: required(env, "WHATSAPP_VERIFY_TOKEN"),
    appSecret: required(env, "WHATSAPP_APP_SECRET"),
    accessToken: required(env, "WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: required(env, "WHATSAPP_PHONE_NUMBER_ID"),
    graphBaseUrl: httpUrl(
      "WHATSAPP_GRAPH_BASE_URL",
      env.WHATSAPP_GRAPH_BASE_URL?.trim() || GRAPH_BASE_URL_DEFAULT,
    ),
    graphApiVersion: version,
    allowedSenders: parseAllowedSenders(env.WHATSAPP_ALLOWED_SENDERS),
    gatewayUrl: httpUrl("WHATSAPP_GATEWAY_URL", required(env, "WHATSAPP_GATEWAY_URL")),
    operatorToken: required(env, "GATEWAY_OPERATOR_TOKEN"),
    workspaceId: required(env, "WHATSAPP_WORKSPACE_ID"),
    botIds,
    stateFile: env.WHATSAPP_STATE_FILE?.trim() || WHATSAPP_STATE_FILE_DEFAULT,
    sendRetries: optionalInt(env, "WHATSAPP_SEND_RETRIES", SEND_RETRIES_DEFAULT),
  };
}
