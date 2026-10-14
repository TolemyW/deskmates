// Tenancy mode and per-tenant limits (ADR-0022 decision 6 and LIMIT-01).

import {
  TENANT_API_REQUESTS_PER_MINUTE_DEFAULT,
  TENANT_MAX_DESKTOP_CONNECTIONS_DEFAULT,
  TENANT_MAX_EVENT_STREAMS_DEFAULT,
  TENANT_MAX_QUEUED_RUNS_DEFAULT,
} from "../tenancy/quotas.js";
import { type TenancyMode, parseTenancyMode } from "../tenancy/tenancy-mode.js";
import { type Env, optionalLimit } from "./env.js";

export interface TenancyConfig {
  /** Queued runs one tenant may have (ADR-0022 LIMIT-01); 0 disables. */
  tenantMaxQueuedRuns?: number;
  /** Operator API requests per minute per tenant (ADR-0022 LIMIT-01); 0 disables. */
  tenantApiRequestsPerMinute?: number;
  /** Open event streams per tenant (ADR-0022 LIMIT-01); 0 disables. */
  tenantMaxEventStreams?: number;
  /** Desktop tickets plus open desktop streams per tenant (ADR-0022 LIMIT-01); 0 disables. */
  tenantMaxDesktopConnections?: number;
  /**
   * Workspace disk quota in MiB over `/work`, `/home` and `/profile` (ADR-0022 LIMIT-01). When
   * set, usage is measured after each run and a workspace over it starts no new run. Omitted or 0:
   * no quota.
   */
  workspaceDiskQuotaMb?: number;
  /**
   * `single` (default) or `multi` (ADR-0022 decision 6, `DESKMATES_TENANCY`). `multi` starts only
   * after `tenancyPreflight` passes; the operator credential stays in the Default Tenant.
   */
  tenancy?: TenancyMode;
}

export function readTenancyConfig(env: Env): TenancyConfig {
  return {
    tenancy: parseTenancyMode(env.DESKMATES_TENANCY),
    tenantMaxQueuedRuns: optionalLimit(
      env,
      "TENANT_MAX_QUEUED_RUNS",
      TENANT_MAX_QUEUED_RUNS_DEFAULT,
    ),
    tenantApiRequestsPerMinute: optionalLimit(
      env,
      "TENANT_API_REQUESTS_PER_MINUTE",
      TENANT_API_REQUESTS_PER_MINUTE_DEFAULT,
    ),
    tenantMaxEventStreams: optionalLimit(
      env,
      "TENANT_MAX_EVENT_STREAMS",
      TENANT_MAX_EVENT_STREAMS_DEFAULT,
    ),
    tenantMaxDesktopConnections: optionalLimit(
      env,
      "TENANT_MAX_DESKTOP_CONNECTIONS",
      TENANT_MAX_DESKTOP_CONNECTIONS_DEFAULT,
    ),
    workspaceDiskQuotaMb: optionalLimit(env, "WORKSPACE_DISK_QUOTA_MB", 0),
  };
}
