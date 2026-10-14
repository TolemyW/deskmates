// Tenant ownership and per-tenant limits (ADR-0022), built together for `buildContext` (issue #53).

import type { GatewayConfig } from "../config.js";
import type { GatewayDb } from "../db/open.js";
import { Ownership } from "./ownership.js";
import {
  TENANT_API_REQUESTS_PER_MINUTE_DEFAULT,
  TENANT_MAX_DESKTOP_CONNECTIONS_DEFAULT,
  TENANT_MAX_EVENT_STREAMS_DEFAULT,
  TENANT_MAX_QUEUED_RUNS_DEFAULT,
  TenantQuotas,
} from "./quotas.js";

export interface TenancyModule {
  /** Which tenant owns a row; the one place every tenant check resolves through (ADR-0022). */
  ownership: Ownership;
  /** Per-tenant queued-run and API request limits (ADR-0022 LIMIT-01). */
  quotas: TenantQuotas;
}

export function createTenancyModule(
  db: GatewayDb,
  config: GatewayConfig,
  clock?: () => Date,
): TenancyModule {
  const ownership = new Ownership(db);
  const quotas = new TenantQuotas(
    db,
    {
      maxQueuedRuns: config.tenantMaxQueuedRuns ?? TENANT_MAX_QUEUED_RUNS_DEFAULT,
      apiRequestsPerMinute:
        config.tenantApiRequestsPerMinute ?? TENANT_API_REQUESTS_PER_MINUTE_DEFAULT,
      maxEventStreams: config.tenantMaxEventStreams ?? TENANT_MAX_EVENT_STREAMS_DEFAULT,
      maxDesktopConnections:
        config.tenantMaxDesktopConnections ?? TENANT_MAX_DESKTOP_CONNECTIONS_DEFAULT,
    },
    clock,
  );
  return { ownership, quotas };
}
