// Connectors (ADR-0012), the integration runtime (ADR-0013) and release-bundled channels
// (ADR-0017).

import { DeskmatesError, type IntegrationRuntimeConfig } from "@deskmates/contracts";
import { type Env, httpUrl, optionalInt, optionalValue } from "./env.js";

/**
 * ADR-0012 item 5: how long a connector validation may be submitted. A guess until the first
 * live campaign calibrates it; recorded in `runs.config_json`.
 */
export const CONNECTOR_VALIDATION_TTL_SECONDS_DEFAULT = 900;

export interface IntegrationsConfig {
  /**
   * Connector validation TTL in seconds (`CONNECTOR_VALIDATION_TTL_SECONDS`, ADR-0012 item 5);
   * recorded in `runs.config_json`. Optional so embedders that predate it keep compiling.
   */
  connectorValidationTtlSeconds?: number;
  /**
   * The integration runtime (ADR-0013): `INTEGRATION_RUNTIME_URL`, `INTEGRATION_RUNTIME_ADMIN_TOKEN`
   * and the optional `INTEGRATION_OAUTH_CALLBACK_URL`. Undefined offers nothing integration-related
   * to runs. Held in memory only; never in the database, a start request or a sandbox.
   */
  integrationRuntime?: IntegrationRuntimeConfig;
  /** Release-generated channel plugin manifest. Undefined loads no channel code. */
  channelPluginManifest?: string;
  /** Private operator directory for channel runtime state. */
  channelStateDir: string;
}

export function readIntegrationsConfig(env: Env): IntegrationsConfig {
  return {
    connectorValidationTtlSeconds: optionalInt(
      env,
      "CONNECTOR_VALIDATION_TTL_SECONDS",
      CONNECTOR_VALIDATION_TTL_SECONDS_DEFAULT,
    ),
    ...optionalValue(env, "CHANNEL_PLUGIN_MANIFEST", "channelPluginManifest"),
    channelStateDir: env.CHANNEL_STATE_DIR?.trim() || "./data/channels",
    ...integrationRuntime(env),
  };
}

/**
 * ADR-0013: the runtime URL and its admin token come together or not at all; one without the
 * other stops startup rather than leaving integrations half-configured. The callback URL is
 * optional (API-key connections need none) but must be a URL when given.
 */
function integrationRuntime(env: Env): {
  integrationRuntime?: IntegrationRuntimeConfig;
} {
  const url = env.INTEGRATION_RUNTIME_URL?.trim() ?? "";
  const adminToken = env.INTEGRATION_RUNTIME_ADMIN_TOKEN?.trim() ?? "";
  const callback = env.INTEGRATION_OAUTH_CALLBACK_URL?.trim() ?? "";
  if (url === "" && adminToken === "") {
    if (callback !== "")
      throw new DeskmatesError(
        "validation",
        "INTEGRATION_OAUTH_CALLBACK_URL needs INTEGRATION_RUNTIME_URL and INTEGRATION_RUNTIME_ADMIN_TOKEN",
      );
    return {};
  }
  if (url === "" || adminToken === "")
    throw new DeskmatesError(
      "validation",
      "INTEGRATION_RUNTIME_URL and INTEGRATION_RUNTIME_ADMIN_TOKEN must be set together",
    );
  return {
    integrationRuntime: {
      url: httpUrl("INTEGRATION_RUNTIME_URL", url),
      adminToken,
      ...(callback === ""
        ? {}
        : { oauthCallbackUrl: httpUrl("INTEGRATION_OAUTH_CALLBACK_URL", callback) }),
    },
  };
}
