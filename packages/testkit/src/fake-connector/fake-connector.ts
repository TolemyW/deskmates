// In-process fake of a connector speaking the ADR-0012 HTTP contract, served through a `fetch`
// function so a T1 Gateway can call it with no socket. It counts executions, keeps its own log of
// what it executed (the reference a coverage report is reconciled against), versions receipts on
// every status change and lets a test script the effect class of each operation.

import { createHash } from "node:crypto";
import {
  type ConnectorCapabilities,
  type ConnectorEffect,
  type ConnectorJsonSchema,
  type ConnectorReceipt,
  type ConnectorValidationResult,
  type ReceiptStatus,
  canonicalJson,
  validateAgainstSchema,
} from "@deskmates/contracts";

/** sha256 of the canonical JSON, lowercase hex: the content hash of ADR-0012. */
export function contentHashOf(submission: unknown): string {
  return createHash("sha256").update(canonicalJson(submission)).digest("hex");
}

export interface FakeConnectorOptions {
  /** Default `http://fake-connector.test`; a request to any other origin is 404. */
  baseUrl?: string;
  name?: string;
  /** When set, every request must carry `Authorization: Bearer <credential>`, else 401. */
  credential?: string;
  /** Effect class per operation; unlisted operations of the default set keep their defaults. */
  effects?: Record<string, ConnectorEffect>;
  submissionSchema?: ConnectorJsonSchema;
}

export interface FakeConnectorRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeConnectorExecution {
  receiptId: string;
  validationId: string;
  contentHash: string;
  idempotencyKey: string;
}

const DEFAULT_EFFECTS: Record<string, ConnectorEffect> = {
  select: "read",
  insert: "reversible",
  notify: "external",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export class FakeConnector {
  readonly baseUrl: string;
  readonly requests: FakeConnectorRequest[] = [];
  /** What the connector executed, one entry per execution, in order. */
  readonly executed: FakeConnectorExecution[] = [];
  private readonly effects: Record<string, ConnectorEffect>;
  private readonly schema: ConnectorJsonSchema;
  private readonly validations = new Map<string, { contentHash: string; valid: boolean }>();
  private readonly byKey = new Map<string, string>();
  private readonly receipts = new Map<string, ConnectorReceipt>();
  private seq = 0;

  constructor(private readonly opts: FakeConnectorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://fake-connector.test").replace(/\/+$/, "");
    this.effects = { ...DEFAULT_EFFECTS, ...(opts.effects ?? {}) };
    this.schema = opts.submissionSchema ?? {
      type: "object",
      required: ["operation", "statement"],
      properties: {
        operation: { type: "string", enum: Object.keys(this.effects) },
        statement: { type: "string" },
      },
      additionalProperties: false,
    };
  }

  get executions(): number {
    return this.executed.length;
  }

  setEffect(operation: string, effect: ConnectorEffect): void {
    this.effects[operation] = effect;
  }

  capabilities(): ConnectorCapabilities {
    return {
      name: this.opts.name ?? "fake-connector",
      version: "0.0.1",
      operations: Object.entries(this.effects).map(([name, effect]) => ({ name, effect })),
      limits: { maxStatementBytes: 65536 },
      submissionSchema: this.schema,
      unsupported: ["multi-statement transactions"],
    };
  }

  /** A status change: the receipt gets a new version, as a real connector's would. */
  advance(receiptId: string, status: ReceiptStatus, resultRef?: string): ConnectorReceipt {
    const current = this.receipts.get(receiptId);
    if (!current) throw new Error(`fake connector has no receipt ${receiptId}`);
    const next: ConnectorReceipt = {
      ...current,
      status,
      version: current.version + 1,
      ...(resultRef === undefined ? {} : { resultRef }),
    };
    this.receipts.set(receiptId, next);
    return next;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = headersOf(init);
    const body = typeof init?.body === "string" ? init.body : "";
    this.requests.push({ method, url, headers, body });
    if (!url.startsWith(`${this.baseUrl}/`)) return json({ error: "not found" }, 404);
    if (
      this.opts.credential !== undefined &&
      headers.authorization !== `Bearer ${this.opts.credential}`
    )
      return json({ error: "unauthorized" }, 401);
    const path = url.slice(this.baseUrl.length);
    const parsed = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (method === "POST" && path === "/describe") return json(this.capabilities());
    if (method === "POST" && path === "/validate") return json(this.validate(parsed.submission));
    if (method === "POST" && path === "/submit") return this.submit(parsed);
    const read = /^\/(status|receipt)\/([^/]+)$/.exec(path);
    if (method === "GET" && read) {
      const receipt = this.receipts.get(decodeURIComponent(read[2] ?? ""));
      return receipt ? json(receipt) : json({ error: "unknown receipt" }, 404);
    }
    return json({ error: "not found" }, 404);
  };

  private validate(submission: unknown): ConnectorValidationResult {
    const validationId = `val-${++this.seq}`;
    const contentHash = contentHashOf(submission);
    const errors = validateAgainstSchema(this.schema, submission);
    const operation =
      submission && typeof submission === "object"
        ? String((submission as Record<string, unknown>).operation)
        : "";
    const effect = this.effects[operation] ?? "external";
    const valid = errors.length === 0;
    this.validations.set(validationId, { contentHash, valid });
    return {
      validationId,
      contentHash,
      valid,
      effect,
      summary: `${operation || "unknown"} (${effect}) on the fake connector`,
      errors,
    };
  }

  private submit(req: Record<string, unknown>): Response {
    const validationId = String(req.validationId);
    const contentHash = String(req.contentHash);
    const idempotencyKey = String(req.idempotencyKey);
    const validation = this.validations.get(validationId);
    if (!validation) return json({ error: "unknown validation" }, 404);
    if (validation.contentHash !== contentHash) return json({ error: "hash mismatch" }, 409);
    if (!validation.valid) return json({ error: "validation failed" }, 409);
    const key = `${contentHash}\u0000${idempotencyKey}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return json(this.receipts.get(existing));
    const receipt: ConnectorReceipt = {
      receiptId: `rcpt-${++this.seq}`,
      status: "accepted",
      version: 1,
      contentHash,
      validationId,
      idempotencyKey,
    };
    this.receipts.set(receipt.receiptId, receipt);
    this.byKey.set(key, receipt.receiptId);
    this.executed.push({ receiptId: receipt.receiptId, validationId, contentHash, idempotencyKey });
    return json(receipt);
  }
}
