// The connector domain (ADR-0012), built together for `buildContext` (issue #53): the registry,
// validations, receipts and the proxy that is their only caller.

import { fetch as undiciFetch } from "undici";
import type { BotStore } from "../bots/bots.js";
import { CONNECTOR_VALIDATION_TTL_SECONDS_DEFAULT, type GatewayConfig } from "../config.js";
import type { GatewayDb } from "../db/open.js";
import type { EventStore } from "../ledger/events.js";
import type { RunStore } from "../ledger/runs.js";
import type { SecretsStore } from "../secrets/secrets-store.js";
import { ConnectorProxy } from "./connector-proxy.js";
import { ReceiptStore } from "./receipts.js";
import { ConnectorRegistry } from "./registry.js";
import { ValidationStore } from "./validations.js";

export interface ConnectorModule {
  connectors: ConnectorRegistry;
  connectorValidations: ValidationStore;
  connectorReceipts: ReceiptStore;
  connectorProxy: ConnectorProxy;
}

export interface ConnectorModuleDeps {
  db: GatewayDb;
  config: GatewayConfig;
  secrets: SecretsStore;
  runs: RunStore;
  bots: BotStore;
  events: EventStore;
  /** How the proxy reaches connectors; tests pass the testkit fake connector's fetch. */
  fetch?: typeof globalThis.fetch;
  /** How a public connector's hostname resolves; tests pin answers instead of using DNS. */
  lookup?: (hostname: string) => Promise<string[]>;
  clock?: () => Date;
}

export function createConnectorModule(deps: ConnectorModuleDeps): ConnectorModule {
  const { db, config } = deps;
  const connectors = new ConnectorRegistry(db, deps.secrets);
  const connectorValidations = new ValidationStore(db);
  const connectorReceipts = new ReceiptStore(db, deps.clock);
  const connectorProxy = new ConnectorProxy({
    registry: connectors,
    validations: connectorValidations,
    receipts: connectorReceipts,
    runs: deps.runs,
    bots: deps.bots,
    events: deps.events,
    // undici's own fetch, so the pinned dispatcher of a public connector is honoured.
    fetch: deps.fetch ?? (undiciFetch as unknown as typeof globalThis.fetch),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    validationTtlSeconds:
      config.connectorValidationTtlSeconds ?? CONNECTOR_VALIDATION_TTL_SECONDS_DEFAULT,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  return { connectors, connectorValidations, connectorReceipts, connectorProxy };
}
