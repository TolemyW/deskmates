// Listeners, the operator credential, the database and the secrets key.

import { DeskmatesError } from "@deskmates/contracts";
import { type Env, optionalInt, optionalValue, required } from "./env.js";

export interface ServerConfig {
  port: number;
  /** Sandbox-facing listener: model proxy, run-scoped sidecar API and health only. */
  bind: string;
  /** Operator-facing listener: authenticated operator API, SSE, webhooks and production UI. */
  operatorPort: number;
  operatorBind: string;
  /** Deployment credential for every `/api/*` route. Held in memory only. */
  operatorToken: string;
  /**
   * Built operator UI (`packages/web/dist`) served at `/` by the operator listener only.
   * Undefined leaves static serving off; the directory must contain `index.html`.
   */
  webDistDir?: string;
  /** `DESKMATES_RELEASE`, the running release tag shown in the UI; undefined when unset. */
  release?: string;
  dbPath: string;
  /** 32-byte base64 key for encrypting refresh tokens at rest; empty disables the secrets store. */
  secretsKey: string;
  /**
   * URL sandboxes use to reach this Gateway (model proxy and internal routes).
   * Undefined means "derive from the listening address once the server is up".
   */
  gatewayBaseUrl: string | undefined;
}

export function readServerConfig(env: Env): ServerConfig {
  const gatewayBaseUrl = env.GATEWAY_BASE_URL?.trim();
  const operatorToken = required(env, "GATEWAY_OPERATOR_TOKEN");
  // Short enough to type from memory: eight hex digits, the first group of a UUID (ADR-0006
  // amendment 3). Guessing 32 bits over HTTP takes weeks; the floor only rejects trivial values.
  if (Buffer.byteLength(operatorToken, "utf8") < 8) {
    throw new DeskmatesError("validation", "GATEWAY_OPERATOR_TOKEN must be at least 8 bytes", {
      key: "GATEWAY_OPERATOR_TOKEN",
    });
  }
  return {
    port: optionalInt(env, "GATEWAY_PORT", 8080),
    bind: env.GATEWAY_BIND?.trim() || "0.0.0.0",
    operatorPort: optionalInt(env, "OPERATOR_PORT", 8081),
    operatorBind: env.OPERATOR_BIND?.trim() || "127.0.0.1",
    operatorToken,
    ...optionalValue(env, "WEB_DIST_DIR", "webDistDir"),
    ...optionalValue(env, "DESKMATES_RELEASE", "release"),
    dbPath: env.GATEWAY_DB?.trim() || "./data/gateway.sqlite",
    secretsKey: env.GATEWAY_SECRETS_KEY?.trim() ?? "",
    gatewayBaseUrl: gatewayBaseUrl ? gatewayBaseUrl.replace(/\/+$/, "") : undefined,
  };
}
