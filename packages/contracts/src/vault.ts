// The workspace credential vault (ADR-0045): a catalog of credentials a workspace's bots use
// through references, never by retrieval. A person enters a value in the operator UI; the Gateway
// keeps it encrypted in its Secrets Store; a bot sees names and references (`vault_list`) and asks
// for a use (`vault_fill` into the shared browser, `vault_request` as one bounded host-side HTTP
// request), which is an L2 credential release. The username is secret payload too.
//
// This is a workspace resource shared by every bot in it, not a boundary between bots (ADR-0004,
// decision 9): a value filled into the shared browser can be recovered by code running in that
// workspace. Tool-mediated use keeps the normal transcript free of plaintext; it does not make a
// credential used inside the workspace inaccessible to that workspace.

import type { ApprovalMode } from "./approval-review.js";
import type { ToolAction } from "./approval.js";
import { isPublicHostname } from "./workspace.js";

/** Decision 1: the initial types. */
export const VAULT_ENTRY_TYPES = ["browser_login", "http_header_token"] as const;
export type VaultEntryType = (typeof VAULT_ENTRY_TYPES)[number];

/** The three tools of decision 4, on the in-process `deskmates` MCP server. */
export const VAULT_TOOL_NAMES = ["vault_list", "vault_fill", "vault_request"] as const;
export type VaultToolName = (typeof VAULT_TOOL_NAMES)[number];

export const VAULT_LIST_TOOL = "mcp__deskmates__vault_list";
export const VAULT_FILL_TOOL = "mcp__deskmates__vault_fill";
export const VAULT_REQUEST_TOOL = "mcp__deskmates__vault_request";

/** The tools that release a credential: L2 by default, never overridable (decision 4). */
export const VAULT_USE_TOOLS: readonly string[] = [VAULT_FILL_TOOL, VAULT_REQUEST_TOOL];

export function isVaultUseTool(toolName: string): boolean {
  return VAULT_USE_TOOLS.includes(toolName);
}

export type VaultOperation = "fill" | "request";

/** Bounds on what a person may store; a value is bounded input to the fill command's stdin. */
export const VAULT_NAME_MAX = 80;
export const VAULT_PURPOSE_MAX = 300;
export const VAULT_VALUE_MAX = 4096;
export const VAULT_REQUESTS_MAX = 20;
export const VAULT_PARAMS_MAX = 20;
/** Decision 7: the bounded response body a `vault_request` may return, in bytes. */
export const VAULT_RESPONSE_MAX_BYTES = 32_768;

/** A parameter the model may supply to a request definition (decision 6). */
export interface VaultRequestParam {
  name: string;
  in: "path" | "query" | "body";
  type: "string" | "integer" | "number" | "boolean";
  required?: boolean;
  /** Strings only; default 256, at most 4096. */
  maxLength?: number;
  /** Strings only: a JavaScript regular expression the whole value must match. */
  pattern?: string;
  /** Strings only: the allowed values. */
  enum?: string[];
}

/** Where the host inserts the token: `Authorization: Bearer …` or one named API-key header. */
export type VaultCredentialHeader = { scheme: "bearer" } | { scheme: "header"; name: string };

/** HTTP methods a definition may use. */
export const VAULT_REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type VaultRequestMethod = (typeof VAULT_REQUEST_METHODS)[number];

/**
 * An operator-maintained request definition (decision 6): the exact origin is the entry's, the
 * method, route, allowed parameters, credential header and declared effect are fixed here. The
 * model supplies permitted parameter values only. `effect: "read"` is the operator's explicit
 * read-only classification; GET alone does not prove it. A credential release stays L2 either
 * way (decision 4); the effect decides whether an interrupted call may be reported as safe to
 * repeat, and it is shown on the approval.
 */
export interface VaultRequestDefinition {
  id: string;
  name: string;
  description?: string;
  method: VaultRequestMethod;
  /** Absolute path with `{param}` placeholders for path parameters, e.g. `/v1/items/{id}`. */
  path: string;
  params: VaultRequestParam[];
  header: VaultCredentialHeader;
  effect: "read" | "write";
}

/** Why an entry cannot be used now; shown on the Vault page (decision 8 and the order note). */
export type VaultUnusableReason = "disabled" | "no_request_definition" | "vault_unavailable";

/** The last use, for the page's "stored, attempted, authenticated" distinction (decision 8). */
export interface VaultLastUse {
  at: string;
  operation: VaultOperation;
  status: VaultUseStatus;
  botId: string;
  runId: string;
}

/** Operator metadata of one entry. Never a saved value, the username included (decision 2). */
export interface VaultEntry {
  id: string;
  workspaceId: string;
  name: string;
  purpose?: string;
  type: VaultEntryType;
  /** Exact HTTPS origin, `https://host[:port]`. */
  targetOrigin: string;
  enabled: boolean;
  revision: number;
  /** Whether a username is stored with a browser login; never the username. */
  hasUsername: boolean;
  usable: boolean;
  unusableReason?: VaultUnusableReason;
  requests: VaultRequestDefinition[];
  lastUse?: VaultLastUse;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** `GET /api/workspaces/:id/vault`. */
export interface VaultView {
  workspaceId: string;
  /** False without `GATEWAY_SECRETS_KEY`: nothing can be stored or used (decision 3). */
  available: boolean;
  /** The workspace approval mode; the page says what it means for a credential release. */
  approvalMode: ApprovalMode;
  entries: VaultEntry[];
}

/** `POST /api/workspaces/:id/vault`. A browser login takes a password; a token takes a token. */
export interface VaultEntryCreateInput {
  name: string;
  purpose?: string;
  type: VaultEntryType;
  targetOrigin: string;
  username?: string;
  password?: string;
  token?: string;
}

/** `PATCH /api/workspaces/:id/vault/:entryId`: metadata only; the value is unchanged. */
export interface VaultEntryPatch {
  expectedRevision: number;
  name?: string;
  purpose?: string | null;
  enabled?: boolean;
  targetOrigin?: string;
}

/** `PUT /api/workspaces/:id/vault/:entryId/value`: the explicit replacement of decision 2. */
export interface VaultValueInput {
  expectedRevision: number;
  username?: string;
  password?: string;
  token?: string;
}

/** `PUT /api/workspaces/:id/vault/:entryId/requests`: the whole list; an id keeps a definition. */
export interface VaultRequestsInput {
  expectedRevision: number;
  requests: Array<Omit<VaultRequestDefinition, "id"> & { id?: string }>;
}

/** What `vault_list` shows a bot: references and non-secret metadata only (decision 1). */
export interface VaultToolEntry {
  id: string;
  name: string;
  purpose?: string;
  type: VaultEntryType;
  targetOrigin: string;
  revision: number;
  requests?: Array<
    Pick<VaultRequestDefinition, "id" | "name" | "description" | "method" | "path" | "params"> & {
      effect: VaultRequestDefinition["effect"];
    }
  >;
}

export interface VaultListing {
  entries: VaultToolEntry[];
  /** Set when the listing is empty, so an empty Vault is told apart from a refusal (decision 8). */
  note?: string;
}

/**
 * Typed outcomes (decision 8). `filled` means only that the fields were filled, not that a login
 * succeeded; `completed` means the HTTP exchange finished with a 2xx. Everything before
 * `released` in the table below happens before any value is decrypted.
 */
export const VAULT_USE_STATUSES = [
  // Success
  "filled",
  "completed",
  // Refused before the value is decrypted
  "not_found",
  "disabled",
  "revision_mismatch",
  "wrong_type",
  "request_not_found",
  "invalid_params",
  "no_grant",
  "takeover",
  "workspace_not_running",
  "vault_unavailable",
  "egress_refused",
  "address_refused",
  // Browser fill outcomes, rechecked by the fill command next to the page
  "target_mismatch",
  "frame_mismatch",
  "stale_tab",
  "missing_fields",
  "ambiguous_fields",
  "not_password_field",
  "navigated",
  "fill_failed",
  // HTTP outcomes
  "auth_failed",
  "http_error",
  "redirect_refused",
  "tls_failed",
  "network_error",
  "result_withheld",
  "unknown",
] as const;
export type VaultUseStatus = (typeof VAULT_USE_STATUSES)[number];

/** The statuses a fill command may answer with. */
export type VaultFillStatus = Extract<
  VaultUseStatus,
  | "filled"
  | "target_mismatch"
  | "frame_mismatch"
  | "stale_tab"
  | "missing_fields"
  | "ambiguous_fields"
  | "not_password_field"
  | "navigated"
  | "fill_failed"
>;

/** A use's answer to the tool: a fixed status, never a value, page text or capture (decision 5). */
export interface VaultUseResult {
  status: VaultUseStatus;
  ok: boolean;
  entryId: string;
  revision: number;
  operation: VaultOperation;
  requestId?: string;
  message: string;
  /** `vault_request` only. */
  httpStatus?: number;
  contentType?: string;
  /** Bounded, untrusted, with known credential echoes removed (decision 7). */
  body?: string;
  bodyTruncated?: true;
  /** The answer recorded for this approval earlier, returned again, never re-executed. */
  recorded?: true;
}

/** `vault_fill` input: references only (decision 4). */
export interface VaultFillToolInput {
  entryId: string;
  revision: number;
  /** The URL of the frame that holds the fields when it is not the top-level page. */
  frameUrl?: string;
  /** CSS selectors of the fields; absent finds the one visible password input and its username. */
  usernameField?: string;
  passwordField?: string;
}

/** `vault_request` input: references and permitted parameter values only (decision 6). */
export interface VaultRequestToolInput {
  entryId: string;
  revision: number;
  requestId: string;
  params?: Record<string, string | number | boolean>;
}

/** Sidecar → Gateway: one use, bound to the approval that released it (decision 4). */
export interface VaultUseRequest {
  entryId: string;
  revision: number;
  approvalId: string;
  toolUseId: string;
}
export type VaultFillUseRequest = VaultUseRequest & {
  tabId: string;
  frameUrl?: string;
  usernameField?: string;
  passwordField?: string;
};
export type VaultRequestUseRequest = VaultUseRequest & {
  requestId: string;
  params: Record<string, string | number | boolean>;
};

/**
 * Gateway → `deskmates-sidecar vault-fill` on stdin (decision 5). The only message that carries a
 * value; it is never logged, never an argument and never written to a file.
 */
export interface VaultFillCommandInput {
  tabId: string;
  origin: string;
  frameUrl?: string;
  usernameField?: string;
  passwordField?: string;
  username: string;
  password: string;
}

export interface VaultFillCommandOutput {
  status: VaultFillStatus;
}

/** Decision 1: an exact HTTPS origin on a public hostname; anything else is undefined. */
export function vaultOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  if (url.pathname !== "/" || url.search || url.hash) return undefined;
  if (value.replace(/\/$/, "") !== url.origin) return undefined;
  if (!isPublicHostname(url.hostname)) return undefined;
  return url.origin;
}

/**
 * The stable dimension a credential release is decided and stored by (decision 4): the entry,
 * its revision and the operation. With the entry's exact origin as `targetOrigin`, these are what
 * a grant binds; a changed revision, target or operation is a different action.
 */
export function vaultActionPattern(ref: {
  entryId: string;
  revision: number;
  operation: VaultOperation;
  requestId?: string;
}): string {
  const op = ref.operation === "request" ? `request:${ref.requestId ?? ""}` : "fill";
  return `vault:${ref.entryId} rev:${ref.revision} op:${op}`;
}

/** Whether an action releases a vault credential (used by the approval policy, decision 4). */
export function isVaultUseAction(action: Pick<ToolAction, "toolName">): boolean {
  return isVaultUseTool(action.toolName);
}

/** The fixed command of decision 5, a subcommand of the preinstalled sidecar binary. */
export const VAULT_FILL_COMMAND: readonly string[] = ["deskmates-sidecar", "vault-fill"];
