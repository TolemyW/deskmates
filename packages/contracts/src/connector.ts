// The connector execution contract (ADR-0012). A connector is an operator-registered external
// service that executes submissions on a system of record. Every connector speaks one HTTP
// contract: POST /describe, POST /validate, POST /submit, GET /status/:receiptId and
// GET /receipt/:receiptId. The Gateway is its only caller; the sidecar reaches it through
// `/internal/runs/:runId/connectors/:connector/*` with the run token.
//
// The Gateway never reads inside a submission: it hashes the canonical JSON, forwards the body,
// and stores the connector's validation verdict and receipts. The pure checks below are what it
// applies to a connector's *responses* before storing them.

import type { RiskLevel } from "./approval.js";
import { DeskmatesError } from "./errors.js";
import type { BotId, Branded, IsoTimestamp, RunId, WorkspaceId } from "./ids.js";
import type { OffsetPageMeta } from "./pagination.js";

export type ConnectorId = Branded<string, "ConnectorId">;

/**
 * `read`: no state change. `reversible`: a change the connector can undo or that has no external
 * effect. `external`: anything else. Maps to L0, L1 and L2 (ADR-0012 definitions and item 6).
 */
export type ConnectorEffect = "read" | "reversible" | "external";

export const CONNECTOR_EFFECTS: readonly ConnectorEffect[] = ["read", "reversible", "external"];

const EFFECT_RISK: Readonly<Record<ConnectorEffect, RiskLevel>> = {
  read: "L0",
  reversible: "L1",
  external: "L2",
};

/** The risk tier of a submit whose stored validation has this effect class (ADR-0012 item 6). */
export function riskForEffect(effect: ConnectorEffect): RiskLevel {
  return EFFECT_RISK[effect];
}

export function isConnectorEffect(value: unknown): value is ConnectorEffect {
  return typeof value === "string" && (CONNECTOR_EFFECTS as readonly string[]).includes(value);
}

/** The five bot-facing sidecar tools (ADR-0012 item 3), in the order the ADR lists them. */
export const CONNECTOR_TOOL_NAMES = [
  "connector_describe",
  "connector_validate",
  "connector_submit",
  "connector_status",
  "connector_receipt",
] as const;

export type ConnectorToolName = (typeof CONNECTOR_TOOL_NAMES)[number];

export type ConnectorOperation = "describe" | "validate" | "submit" | "status" | "receipt";

/** Receipt status vocabulary (ADR-0012 item 4). A status change is a new receipt version. */
export type ReceiptStatus = "accepted" | "running" | "succeeded" | "failed" | "rejected";

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "rejected",
];

export function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return typeof value === "string" && (RECEIPT_STATUSES as readonly string[]).includes(value);
}

// --- Registration (operator API) -----------------------------------------------------------

/**
 * A registered connector as the operator API and the run routes show it. It carries no URL and
 * no credential: both live encrypted in the Secrets Store and only the Gateway reads them.
 */
export interface ConnectorRegistration {
  id: ConnectorId;
  workspaceId: WorkspaceId;
  /** Unique per workspace; what a bot's `connectors` list and the tools name. */
  name: string;
  /** Free-form label for the operator, e.g. `database`. */
  kind: string;
  /** The operator marked the URL public: it is then held to the non-public address rules. */
  publicUrl: boolean;
  createdAt: IsoTimestamp;
}

/**
 * `GET /api/connectors?workspaceId=` (#113): one page of connectors, oldest first
 * (`created_at, id`), with the honest total.
 */
export interface ConnectorPage extends OffsetPageMeta {
  connectors: ConnectorRegistration[];
}

/** `POST /api/connectors`. `url` and `credential` go to the Secrets Store, never to a column. */
export interface RegisterConnectorRequest {
  workspaceId: WorkspaceId;
  name: string;
  kind?: string;
  url: string;
  /** Sent to the connector as `Authorization: Bearer <credential>` by the Gateway only. */
  credential?: string;
  publicUrl?: boolean;
}

// --- Capabilities (POST /describe) ---------------------------------------------------------

/** The subset of JSON Schema a capabilities document may use for its submission schema. */
export interface ConnectorJsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Readonly<Record<string, ConnectorJsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: ConnectorJsonSchema;
  enum?: readonly (string | number | boolean | null)[];
  description?: string;
}

export interface ConnectorOperationSpec {
  name: string;
  effect: ConnectorEffect;
  description?: string;
}

export interface ConnectorCapabilities {
  name: string;
  version: string;
  operations: ConnectorOperationSpec[];
  /** Per-connector limits (rows, bytes, submissions per minute); guesses until calibrated. */
  limits: Record<string, number>;
  submissionSchema: ConnectorJsonSchema;
  /** Human-readable "what this connector does not support". */
  unsupported: string[];
}

// --- Validation (POST /validate) -----------------------------------------------------------

/** What the Gateway posts to `/validate`: the opaque body and the hash it computed over it. */
export interface ConnectorSubmissionEnvelope {
  submission: unknown;
  /** sha256 of `canonicalJson(submission)`, lowercase hex. */
  contentHash: string;
}

export type ConnectorFieldErrorCode =
  | "required"
  | "type"
  | "enum"
  | "additional_property"
  | "unsupported"
  | "invalid";

/** A field-specific validation error. `path` is `a.b[2].c`; empty for the submission itself. */
export interface ConnectorFieldError {
  path: string;
  code: ConnectorFieldErrorCode;
  message: string;
}

export interface ConnectorValidationResult {
  validationId: string;
  contentHash: string;
  valid: boolean;
  effect: ConnectorEffect;
  /** Human-readable; this, never the body, is what an approval request shows. */
  summary: string;
  errors: ConnectorFieldError[];
}

/**
 * The Gateway's stored validation: the connector's verdict bound to the run that asked. The
 * sidecar's PreToolUse hook reads the effect class from here, never from the tool input.
 */
export interface StoredConnectorValidation extends ConnectorValidationResult {
  connectorId: ConnectorId;
  runId: RunId;
  botId: BotId;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
}

// --- Submit, status, receipt ---------------------------------------------------------------

/** What `/submit` takes: a prior validation, the hash it was for, and an idempotency key. */
export interface ConnectorSubmitRequest {
  validationId: string;
  contentHash: string;
  idempotencyKey: string;
}

/** A connector's receipt, as `/submit`, `/status` and `/receipt` return it. */
export interface ConnectorReceipt {
  receiptId: string;
  status: ReceiptStatus;
  /** The connector's receipt version; it increases with every status change. */
  version: number;
  contentHash: string;
  validationId: string;
  idempotencyKey: string;
  /** Where the result lives (a result-set id, a file, a ticket URL); opaque to the Gateway. */
  resultRef?: string;
  detail?: string;
}

/** One immutable version of a stored receipt. */
export interface ReceiptVersion {
  version: number;
  status: ReceiptStatus;
  resultRef?: string;
  detail?: string;
  recordedAt: IsoTimestamp;
}

/**
 * The Gateway's authoritative receipt (ADR-0012 item 4). Rows are never updated; a status change
 * adds a version. A workspace file mirroring it is a convenience, never the truth.
 */
export interface ConnectorReceiptRecord {
  receiptId: string;
  connectorId: ConnectorId;
  workspaceId: WorkspaceId;
  runId: RunId;
  botId: BotId;
  contentHash: string;
  validationId: string;
  idempotencyKey: string;
  current: ReceiptVersion;
  versions: ReceiptVersion[];
}

/** The sidecar's `submit` answer: the receipt and whether it already existed (no execution). */
export interface ConnectorSubmitResponse {
  receipt: ConnectorReceiptRecord;
  duplicate: boolean;
}

// --- Canonical JSON and hashes -------------------------------------------------------------

/**
 * The canonical JSON of a submission: object keys sorted by code unit at every depth, no
 * whitespace, array order kept, `undefined` members omitted as `JSON.stringify` does. A value
 * JSON cannot carry (non-finite number, bigint, function, symbol, top-level undefined) is a
 * `validation` error. The content hash is sha256 of this string, lowercase hex; the hashing
 * itself happens in the Gateway and the sidecar, since contracts has no runtime dependencies.
 */
export function canonicalJson(value: unknown): string {
  const out = encode(value, "");
  if (out === undefined)
    throw new DeskmatesError("validation", "a submission must be a JSON value", { path: "" });
  return out;
}

function encode(value: unknown, path: string): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value))
        throw new DeskmatesError("validation", "a submission number must be finite", { path });
      return JSON.stringify(value);
    case "undefined":
      return undefined;
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => encode(v, `${path}[${i}]`) ?? "null").join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const encoded = encode(record[key], path === "" ? key : `${path}.${key}`);
        if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new DeskmatesError("validation", `a submission cannot hold a ${typeof value}`, {
        path,
      });
  }
}

const CONTENT_HASH = /^[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH.test(value);
}

// --- Submission schema check ---------------------------------------------------------------

function typeMatches(type: NonNullable<ConnectorJsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
  }
}

/**
 * Check a value against the capabilities subset of JSON Schema and return one field-specific
 * error per problem, in document order. A connector may use it for its dry check; the Gateway
 * never does, because what a submission means is the connector's business.
 */
export function validateAgainstSchema(
  schema: ConnectorJsonSchema,
  value: unknown,
  path = "",
): ConnectorFieldError[] {
  const at = path === "" ? "submission" : path;
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    return [{ path, code: "type", message: `${at} must be ${schema.type}` }];
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    return [
      { path, code: "enum", message: `${at} must be one of ${schema.enum.map(String).join(", ")}` },
    ];
  }
  const errors: ConnectorFieldError[] = [];
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(items, item, `${path}[${i}]`));
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const child = (key: string) => (path === "" ? key : `${path}.${key}`);
    for (const key of schema.required ?? []) {
      if (record[key] === undefined)
        errors.push({ path: child(key), code: "required", message: `${child(key)} is required` });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (record[key] !== undefined)
        errors.push(...validateAgainstSchema(sub, record[key], child(key)));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in (schema.properties ?? {})))
          errors.push({
            path: child(key),
            code: "additional_property",
            message: `${child(key)} is not a field of this connector's submissions`,
          });
      }
    }
  }
  return errors;
}

// --- Checks on connector responses ---------------------------------------------------------

function protocol(what: string, details: Record<string, unknown> = {}): DeskmatesError {
  return new DeskmatesError("connector_protocol", `connector answered with ${what}`, details);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw protocol(`a ${what} that is not an object`);
  return value as Record<string, unknown>;
}

function str(r: Record<string, unknown>, key: string, what: string): string {
  const v = r[key];
  if (typeof v !== "string" || v === "") throw protocol(`a ${what} without a string ${key}`);
  return v;
}

function optionalStr(r: Record<string, unknown>, key: string, what: string): string | undefined {
  const v = r[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw protocol(`a ${what} whose ${key} is not a string`);
  return v;
}

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw protocol(`a ${what} that is not a string array`);
  return value as string[];
}

export function parseConnectorCapabilities(value: unknown): ConnectorCapabilities {
  const r = record(value, "capabilities document");
  if (!Array.isArray(r.operations)) throw protocol("capabilities without operations");
  const operations = r.operations.map((op) => {
    const o = record(op, "operation");
    if (!isConnectorEffect(o.effect))
      throw protocol("an operation with an unknown effect class", { effect: o.effect });
    const description = optionalStr(o, "description", "operation");
    return {
      name: str(o, "name", "operation"),
      effect: o.effect,
      ...(description === undefined ? {} : { description }),
    };
  });
  const limits = record(r.limits ?? {}, "limits");
  for (const [k, v] of Object.entries(limits)) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw protocol("a non-numeric limit", { k });
  }
  return {
    name: str(r, "name", "capabilities document"),
    version: str(r, "version", "capabilities document"),
    operations,
    limits: limits as Record<string, number>,
    submissionSchema: record(r.submissionSchema, "submission schema") as ConnectorJsonSchema,
    unsupported: stringArray(r.unsupported ?? [], "unsupported list"),
  };
}

const FIELD_ERROR_CODES: readonly ConnectorFieldErrorCode[] = [
  "required",
  "type",
  "enum",
  "additional_property",
  "unsupported",
  "invalid",
];

export function parseConnectorValidation(value: unknown): ConnectorValidationResult {
  const r = record(value, "validation result");
  if (!isContentHash(r.contentHash)) throw protocol("a validation without a sha256 content hash");
  if (typeof r.valid !== "boolean") throw protocol("a validation without a boolean valid");
  if (!isConnectorEffect(r.effect))
    throw protocol("a validation with an unknown effect class", { effect: r.effect });
  if (typeof r.summary !== "string") throw protocol("a validation without a summary");
  if (!Array.isArray(r.errors)) throw protocol("a validation without an errors array");
  const errors = r.errors.map((e) => {
    const f = record(e, "field error");
    if (typeof f.path !== "string" || typeof f.message !== "string")
      throw protocol("a field error without a path and message");
    const code = (FIELD_ERROR_CODES as readonly unknown[]).includes(f.code)
      ? (f.code as ConnectorFieldErrorCode)
      : "invalid";
    return { path: f.path, code, message: f.message };
  });
  return {
    validationId: str(r, "validationId", "validation result"),
    contentHash: r.contentHash,
    valid: r.valid,
    effect: r.effect,
    summary: r.summary,
    errors,
  };
}

export function parseConnectorReceipt(value: unknown): ConnectorReceipt {
  const r = record(value, "receipt");
  if (!isReceiptStatus(r.status))
    throw protocol("a receipt with an unknown status", { status: r.status });
  if (typeof r.version !== "number" || !Number.isSafeInteger(r.version) || r.version < 1)
    throw protocol("a receipt without a positive integer version");
  if (!isContentHash(r.contentHash)) throw protocol("a receipt without a sha256 content hash");
  const resultRef = optionalStr(r, "resultRef", "receipt");
  const detail = optionalStr(r, "detail", "receipt");
  return {
    receiptId: str(r, "receiptId", "receipt"),
    status: r.status,
    version: r.version,
    contentHash: r.contentHash,
    validationId: str(r, "validationId", "receipt"),
    idempotencyKey: str(r, "idempotencyKey", "receipt"),
    ...(resultRef === undefined ? {} : { resultRef }),
    ...(detail === undefined ? {} : { detail }),
  };
}
