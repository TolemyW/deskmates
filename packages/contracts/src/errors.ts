// Errors that cross a package boundary. Each carries a stable `code` for API responses and tests.

export type DeskmatesErrorCode =
  | "not_found"
  | "invalid_transition"
  | "lane_busy"
  | "queue_full"
  | "egress_blocked"
  | "browser_held_by_human"
  | "relay_cap_breached"
  | "turn_budget_breached"
  | "sandbox_unavailable"
  | "token_rejected"
  // Too many failed sign-in attempts for a login name or client address (ADR-0022 decision 2).
  | "rate_limited"
  // A service principal's own budget (concurrent runs or today's known cost) is spent
  // (ADR-0022 amendment 2); retry later.
  | "budget_exceeded"
  // The workspace's monetary budget is spent (ADR-0032 decision 5): the model proxy refuses a
  // call with it (402, final) and Continue is refused with it (409) until a limit is raised.
  | "budget_exhausted"
  | "validation"
  // A valid credential that does not cover this resource: another run's token on a connector
  // route, or a connector of another workspace (ADR-0012 item 2).
  | "forbidden"
  // The model proxy refused a request whose body names a model the run was not started on
  // (ADR-0023 decision 1). Final: the proxy sends `x-should-retry: false` with it.
  | "model_not_selected"
  // A request the policy would allow but whose content exceeds a configured size cap, e.g. a
  // workspace file larger than the download limit (ADR-0014 decision 2).
  | "payload_too_large"
  // A known invitation link that was used, revoked or expired; `details.reason` says which
  // (ADR-0022 amendment 4 I6). An unknown token stays `token_rejected`.
  | "invitation_unusable"
  // A learned memory write of scope `rule`: rules change only through the operator API
  // (ADR-0011 item 1).
  | "memory_rule_refused"
  // Connector execution contract (ADR-0012 items 1 and 5).
  | "connector_unavailable"
  | "connector_protocol"
  | "connector_validation_missing"
  | "connector_validation_stale"
  | "connector_validation_wrong_connector"
  | "connector_validation_invalid"
  | "connector_hash_mismatch"
  // Integration runtime (ADR-0013 items 3, 5 and 8); HTTP statuses in `integration.ts`.
  | "integration_unavailable"
  | "integration_connection_not_allowed"
  | "integration_not_adopted"
  | "integration_protocol"
  // A person or service principal posted to a thread owned by an external chat channel. Its Web
  // view is a read-only mirror; the human replies on that channel (ADR-0017 amendment 2).
  | "channel_thread_read_only"
  // The workspace's disk is full or over its filesystem quota while writing an upload; the
  // partial upload is kept consistent and can resume (ADR-0014 amendment A5 decision 30).
  | "storage_exhausted";

export class DeskmatesError extends Error {
  readonly code: DeskmatesErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DeskmatesErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DeskmatesError";
    this.code = code;
    this.details = details;
  }
}

export function isDeskmatesError(err: unknown): err is DeskmatesError {
  return err instanceof DeskmatesError;
}

/**
 * Every code as a runtime list, so a body that arrives over HTTP can be checked before its `code`
 * is trusted. The assertion below fails the build when a code is added to the union and not here.
 */
const DESKMATES_ERROR_CODES = [
  "not_found",
  "invalid_transition",
  "lane_busy",
  "queue_full",
  "egress_blocked",
  "browser_held_by_human",
  "relay_cap_breached",
  "turn_budget_breached",
  "sandbox_unavailable",
  "token_rejected",
  "rate_limited",
  "budget_exceeded",
  "budget_exhausted",
  "validation",
  "forbidden",
  "model_not_selected",
  "payload_too_large",
  "invitation_unusable",
  "memory_rule_refused",
  "connector_unavailable",
  "connector_protocol",
  "connector_validation_missing",
  "connector_validation_stale",
  "connector_validation_wrong_connector",
  "connector_validation_invalid",
  "connector_hash_mismatch",
  "integration_unavailable",
  "integration_connection_not_allowed",
  "integration_not_adopted",
  "integration_protocol",
  "channel_thread_read_only",
  "storage_exhausted",
] as const satisfies readonly DeskmatesErrorCode[];

type MissingErrorCode = Exclude<DeskmatesErrorCode, (typeof DESKMATES_ERROR_CODES)[number]>;
const codesAreExhaustive: [MissingErrorCode] extends [never] ? true : false = true;
void codesAreExhaustive;

const DESKMATES_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(DESKMATES_ERROR_CODES);

/** A `DeskmatesErrorCode` read from untrusted bytes: checked, not cast. */
export function isDeskmatesErrorCode(value: unknown): value is DeskmatesErrorCode {
  return typeof value === "string" && DESKMATES_ERROR_CODE_SET.has(value);
}
