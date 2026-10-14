// The integration runtime access (ADR-0013), built for `buildContext` (issue #53). No runtime is
// configured, no adapter: the service then reports integrations as unavailable.

import type { BotStore } from "../bots/bots.js";
import type { GatewayConfig } from "../config.js";
import type { GatewayDb } from "../db/open.js";
import type { EventStore } from "../ledger/events.js";
import type { RunStore } from "../ledger/runs.js";
import type { SecretsStore } from "../secrets/secrets-store.js";
import type { WorkspaceStore } from "../workspaces/workspaces.js";
import { IntegrationService } from "./integration-service.js";
import { IntegrationStore } from "./integration-store.js";
import { RuntimeAdapter } from "./runtime-adapter.js";

export interface IntegrationModuleDeps {
  db: GatewayDb;
  config: GatewayConfig;
  secrets: SecretsStore;
  runs: RunStore;
  bots: BotStore;
  workspaces: WorkspaceStore;
  events: EventStore;
  /** How the Gateway reaches the integration runtime; tests pass the testkit fake's fetch. */
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}

export function createIntegrationService(deps: IntegrationModuleDeps): IntegrationService {
  const runtime = deps.config.integrationRuntime;
  return new IntegrationService({
    store: new IntegrationStore(deps.db),
    adapter: runtime
      ? new RuntimeAdapter({
          url: runtime.url,
          adminToken: runtime.adminToken,
          fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
        })
      : undefined,
    oauthCallbackUrl: runtime?.oauthCallbackUrl,
    secrets: deps.secrets,
    runs: deps.runs,
    bots: deps.bots,
    workspaces: deps.workspaces,
    events: deps.events,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
}
