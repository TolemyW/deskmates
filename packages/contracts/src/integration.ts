// SaaS integrations through an integration runtime behind the Gateway (ADR-0013 and its
// Amendment 1). The runtime (OpenConnector at first) is a deployed service the Gateway alone
// reaches; nothing here names its routes or its tool names. These are the shapes the Gateway, the
// sidecar and the web share: a workspace's connections, adopted providers, the catalog facts of an
// action, the tier rule, the shaped results a run sees, and the typed errors.

import type { RiskLevel } from "./approval.js";
import type { DeskmatesErrorCode } from "./errors.js";
import type { Branded, IsoTimestamp, WorkspaceId } from "./ids.js";
import type { OffsetPageMeta } from "./pagination.js";

export type IntegrationConnectionId = Branded<string, "IntegrationConnectionId">;

/** The runtime's catalog classification of an action (ADR-0013 item 6). */
export type IntegrationOperationType = "read" | "write" | "destructive";

export const INTEGRATION_OPERATION_TYPES: readonly IntegrationOperationType[] = [
  "read",
  "write",
  "destructive",
];

export function isIntegrationOperationType(value: unknown): value is IntegrationOperationType {
  return (
    typeof value === "string" && (INTEGRATION_OPERATION_TYPES as readonly string[]).includes(value)
  );
}

/** How a connection was authorised: an OAuth grant or an API key the operator entered. */
export type IntegrationAuthKind = "oauth" | "api_key";

/**
 * Where the Gateway finds the runtime (`INTEGRATION_RUNTIME_URL`, `INTEGRATION_RUNTIME_ADMIN_TOKEN`,
 * `INTEGRATION_OAUTH_CALLBACK_URL`). Held by the Gateway only: no part of it reaches a sandbox, a
 * start request or the database (ADR-0013 item 4).
 */
export interface IntegrationRuntimeConfig {
  /** Base URL on the private network only the Gateway reaches, e.g. `http://integration-runtime:3000`. */
  url: string;
  adminToken: string;
  /** Public URL of `GET /api/integrations/oauth/callback`; OAuth is unavailable without it. */
  oauthCallbackUrl?: string;
}

/**
 * One authorised account of one provider, belonging to one workspace (ADR-0013 item 3, Amendment
 * 1). The Gateway's table is the truth for which workspace owns it; the runtime only knows the
 * connection and the per-workspace token it is granted to. No credential appears here.
 */
export interface IntegrationConnection {
  id: IntegrationConnectionId;
  workspaceId: WorkspaceId;
  service: string;
  /** Unique per workspace and service; what a bot passes as `connectionName`. */
  connectionName: string;
  /** The runtime's id of the connection (what its token grant lists). */
  runtimeConnectionId: string;
  authKind: IntegrationAuthKind;
  createdAt: IsoTimestamp;
  /** Set when the operator revoked it; a revoked connection is no longer granted to any token. */
  revokedAt?: IsoTimestamp;
}

/** Which connections a page lists: live ones, revoked ones, or both (absent). */
export type IntegrationConnectionStatus = "live" | "revoked";

/**
 * `GET /api/integrations/workspaces/:id/connections` (#113): one page of a workspace's
 * connections, oldest first (`created_at, id`), with the honest total under the status filter.
 * `liveByService` counts every live connection of the workspace per service, whatever page is
 * shown, so a provider's "connected" state never comes from one page.
 */
export interface IntegrationConnectionPage extends OffsetPageMeta {
  connections: IntegrationConnection[];
  liveByService: { service: string; count: number }[];
}

/**
 * A provider an operator has adopted (ADR-0013 item 8). Only adopted providers are offered to
 * runs; the long tail of the catalog is not.
 */
export interface AdoptedIntegrationProvider {
  service: string;
  displayName: string;
  /** Auth kinds the runtime reports for the provider, restricted to the two the Gateway drives. */
  authKinds: IntegrationAuthKind[];
  adoptedAt: IsoTimestamp;
}

/**
 * One provider of the runtime's catalog as the operator UI lists it (`GET
 * /api/integrations/catalog`): adopted or not, with the auth kinds the Gateway can drive.
 */
export interface IntegrationCatalogEntry {
  service: string;
  displayName: string;
  authKinds: IntegrationAuthKind[];
  adopted: boolean;
}

export interface IntegrationCatalog {
  configured: boolean;
  /** False when the runtime answered but its provider list could not be read; adopted only. */
  complete: boolean;
  providers: IntegrationCatalogEntry[];
}

/** The catalog facts of one action, as a search result and the tier route carry them. */
export interface IntegrationActionSummary {
  /** `<service>.<name>`. */
  actionId: string;
  service: string;
  name: string;
  /** The catalog description (20 to 131 characters for Slack and Drive in the spike). */
  description: string;
  operationType: IntegrationOperationType;
  requiredScopes: string[];
}

/** One input parameter of an action, from the runtime's input summary. */
export interface IntegrationActionInput {
  name: string;
  required: boolean;
  type: string;
  description?: string;
}

/**
 * An operator's registry entry for one action (ADR-0013 item 6, Amendment 1). `lowerableToL1`
 * lowers a `write` action to L1; `neverLowerable` pins it at L2 and wins over `lowerableToL1`.
 * A `destructive` action is L2 whatever the override says.
 */
export interface IntegrationTierOverride {
  lowerableToL1: boolean;
  neverLowerable: boolean;
}

export interface IntegrationActionOverride extends IntegrationTierOverride {
  actionId: string;
  updatedAt: IsoTimestamp;
}

/** Actions seeded as never lowerable: they can share with anyone or transfer ownership (Amendment 1). */
export const NEVER_LOWERABLE_ACTIONS: readonly string[] = [
  "googledrive.permissions.create",
  "googledrive.permissions.update",
];

/**
 * ADR-0013 item 6: `read` is L0; `write` is L2 unless an operator lowered this action to L1 and
 * did not mark it never lowerable; `destructive` is L2 and cannot be lowered.
 */
export function tierForAction(
  operationType: IntegrationOperationType,
  override?: IntegrationTierOverride,
): RiskLevel {
  switch (operationType) {
    case "read":
      return "L0";
    case "write":
      return override?.lowerableToL1 === true && override.neverLowerable !== true ? "L1" : "L2";
    case "destructive":
      return "L2";
  }
}

/** `<service>.<name>`: the service is everything before the first dot. */
const ACTION_ID = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.([A-Za-z0-9_.-]+)$/;

export function isIntegrationActionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && ACTION_ID.test(value);
}

/** The service of an action id, or undefined when the id is not `<service>.<name>`. */
export function integrationServiceOf(actionId: string): string | undefined {
  return ACTION_ID.exec(actionId)?.[1];
}

const SERVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isIntegrationService(value: unknown): value is string {
  return typeof value === "string" && SERVICE.test(value);
}

/**
 * What an operator may call a connection: short, lower case, and safe inside the runtime's own
 * connection-name rule (`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`) once the Gateway prefixes it with the
 * workspace (Amendment 1: the runtime has no tenant field).
 */
const CONNECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isIntegrationConnectionName(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_NAME.test(value);
}

/** The five bot-facing sidecar tools (ADR-0013 item 5), in the order the ADR lists them. */
export const INTEGRATION_TOOL_NAMES = [
  "integration_apps",
  "integration_connections",
  "integration_search",
  "integration_guide",
  "integration_execute",
] as const;

export type IntegrationToolName = (typeof INTEGRATION_TOOL_NAMES)[number];

export type IntegrationOperation = "apps" | "connections" | "search" | "guide" | "execute";

/** Most actions a search returns (Amendment 1: 20 raw results cost up to 9,500 tokens). */
export const INTEGRATION_SEARCH_LIMIT_MAX = 5;

// --- Shaped results a run sees (all wrapped as untrusted by the sidecar) --------------------

export interface IntegrationAppsResult {
  apps: { service: string; displayName: string; connections: string[] }[];
}

export interface IntegrationConnectionsResult {
  connections: {
    service: string;
    connectionName: string;
    authKind: IntegrationAuthKind;
    /** The account the provider reports for the credential, when it reports one. */
    account?: string;
  }[];
}

export interface IntegrationSearchResult {
  service: string;
  actions: (IntegrationActionSummary & { inputs: IntegrationActionInput[] })[];
}

export interface IntegrationGuideResult {
  actionId: string;
  service: string;
  connectionName: string;
  operationType: IntegrationOperationType;
  requiredScopes: string[];
  /** The runtime's agent-facing guide, markdown. */
  guide: string;
}

export interface IntegrationExecuteResult {
  ok: boolean;
  actionId: string;
  service: string;
  connectionName: string;
  operationType: IntegrationOperationType;
  /** The runtime's execution id, when it returned one (ADR-0013 item 7). */
  executionId?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

/**
 * What the PreToolUse hook reads before `integration_execute` (ADR-0013 item 6): the catalog
 * facts, the operator's override and the tier they give. Approval identity/tier comes from this;
 * Drive also carries a bounded, redacted proposed-input preview (ADR-0013 Amendment 2).
 */
export interface IntegrationActionTier extends IntegrationActionSummary {
  connectionName: string;
  override: IntegrationTierOverride;
  tier: RiskLevel;
}

// --- Operator requests ----------------------------------------------------------------------

export interface AdoptIntegrationProviderRequest {
  service: string;
  displayName?: string;
}

export interface CreateApiKeyConnectionRequest {
  service: string;
  connectionName: string;
  /** Passed to the runtime once; the Gateway stores none of it. */
  apiKey: string;
  /** Provider-specific extra values (e.g. a self-hosted `baseUrl`). */
  values?: Record<string, string>;
}

export interface StartOAuthConnectionRequest {
  service: string;
  connectionName: string;
}

export interface StartOAuthConnectionResponse {
  authorizationUrl: string;
}

export interface SetIntegrationOverrideRequest {
  lowerableToL1?: boolean;
  neverLowerable?: boolean;
}

// --- Typed errors -------------------------------------------------------------------------

export type IntegrationErrorCode = Extract<
  DeskmatesErrorCode,
  | "integration_unavailable"
  | "integration_connection_not_allowed"
  | "integration_not_adopted"
  | "integration_protocol"
>;

/**
 * HTTP status per integration error. Unavailable: the runtime is not configured or cannot be
 * reached. Not allowed: a connection that is not the run's workspace's (item 3). Not adopted: the
 * provider is outside the deployment's adopted set (item 8). Protocol: the runtime answered with
 * something the Gateway cannot read.
 */
export const INTEGRATION_ERROR_STATUS: Readonly<Record<IntegrationErrorCode, number>> = {
  integration_unavailable: 503,
  integration_connection_not_allowed: 403,
  integration_not_adopted: 409,
  integration_protocol: 502,
};
