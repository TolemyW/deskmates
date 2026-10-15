// Gateway configuration, read from the environment variables listed in `.env.example`.
// The model is configuration: DEFAULT_MODEL and CHEAP_MODEL are required and never defaulted here.
//
// Each domain reads its own variables in `config/<domain>.ts` (issue #53); this file composes
// them and is the one import path for the config type, its defaults and `loadConfig`.

import { type AppSharesConfig, readAppSharesConfig } from "./config/app-shares.js";
import type { AuthSettings } from "./config/auth.js";
import { authConfig } from "./config/auth.js";
import { type BrowserConfig, readBrowserConfig } from "./config/browser.js";
import { type IntegrationsConfig, readIntegrationsConfig } from "./config/integrations.js";
import { type ModelConfig, readModelConfig } from "./config/model.js";
import { type RunsConfig, readRunsConfig } from "./config/runs.js";
import { type SandboxConfig, readSandboxConfig, readSandboxProvider } from "./config/sandbox.js";
import { type ServerConfig, readServerConfig } from "./config/server.js";
import { type TenancyConfig, readTenancyConfig } from "./config/tenancy.js";

export { authConfig } from "./config/auth.js";
export { CONNECTOR_VALIDATION_TTL_SECONDS_DEFAULT } from "./config/integrations.js";
export { MODEL_TOKEN_TTL_SECONDS_DEFAULT } from "./config/model.js";
export {
  GROUP_ROUTING_DEFAULT,
  MAX_TURNS_DEFAULT,
  RUN_TIMEOUT_SECONDS_DEFAULT,
  THREAD_PAYLOAD_MAX_TOKENS_DEFAULT,
  WEBHOOK_BODY_MAX_BYTES_DEFAULT,
  WEBHOOK_QUEUE_MAX_DEFAULT,
} from "./config/runs.js";
export {
  WORKSPACE_CPU_LIMIT_DEFAULT,
  WORKSPACE_MEMORY_LIMIT_MB_DEFAULT,
} from "./config/sandbox.js";

export interface GatewayConfig
  extends AppSharesConfig,
    AuthSettings,
    BrowserConfig,
    IntegrationsConfig,
    ModelConfig,
    RunsConfig,
    SandboxConfig,
    ServerConfig,
    TenancyConfig {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  // The provider is checked first, then the operator credential, as before the split.
  readSandboxProvider(env);
  return {
    ...readServerConfig(env),
    ...readModelConfig(env),
    ...readSandboxConfig(env),
    ...readRunsConfig(env),
    ...readTenancyConfig(env),
    ...readBrowserConfig(env),
    ...readIntegrationsConfig(env),
    ...readAppSharesConfig(env),
    auth: authConfig(env),
  };
}
