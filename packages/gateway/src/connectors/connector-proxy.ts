// The connector proxy: the only caller of a connector (ADR-0012 item 2). A run reaches it through
// `/internal/runs/:runId/connectors/:connector/*`; the proxy resolves the connector in the run's
// workspace, decrypts its endpoint, forwards the body without reading inside it, and stores the
// validation verdicts and receipts. Every call is attributed in the run's ledger as a `tool_call`
// and a `tool_result` carrying the connector id, and for submit the validation id, content hash
// and receipt id (item 7), so coverage is computed from receipts and events, never from files.

import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { type LookupFunction, isIP } from "node:net";
import {
  type ConnectorCapabilities,
  type ConnectorOperation,
  type ConnectorReceipt,
  type ConnectorReceiptRecord,
  type ConnectorRegistration,
  type ConnectorSubmitResponse,
  DeskmatesError,
  type RunId,
  type StoredConnectorValidation,
  isContentHash,
  isDeskmatesError,
  parseConnectorCapabilities,
  parseConnectorReceipt,
  parseConnectorValidation,
} from "@deskmates/contracts";
import { Agent } from "undici";
import type { BotStore } from "../bots/bots.js";
import type { EventStore } from "../ledger/events.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";
import { isPublicAddress } from "../net/public-address.js";
import { contentHash } from "./content-hash.js";
import type { ReceiptStore } from "./receipts.js";
import type { ConnectorRegistry } from "./registry.js";
import type { ValidationStore } from "./validations.js";

/**
 * Per-call deadline towards a connector. Shorter than the sidecar's own deadline for these routes,
 * so the sidecar hears a typed `connector_unavailable` instead of timing out itself.
 */
export const CONNECTOR_CALL_TIMEOUT_MS = 25_000;

export interface ConnectorProxyDeps {
  registry: ConnectorRegistry;
  validations: ValidationStore;
  receipts: ReceiptStore;
  runs: RunStore;
  bots: BotStore;
  events: EventStore;
  fetch: typeof globalThis.fetch;
  /**
   * Resolves a host to every address it has. A public connector is called only when all of them
   * are public (ADR-0022 INT-02); defaults to the system resolver.
   */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Which resolved addresses a public connector may be reached on; `isPublicAddress` by default. */
  addressAllowed?: (address: string) => boolean;
  validationTtlSeconds: number;
  clock?: () => Date;
  timeoutMs?: number;
}

/**
 * A one-call HTTP dispatcher whose name lookups answer with `addresses` only: the connection goes
 * to an address that was checked, whatever DNS says by then. TLS still verifies the hostname.
 */
export function pinnedDispatcher(addresses: readonly string[]): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(addresses) } });
}

export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const answers = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((_hostname: string, options: LookupOptions | number, callback: unknown) => {
    const done = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;
    const all = typeof options === "object" && options !== null && options.all === true;
    const first = answers[0];
    if (!first)
      return done(Object.assign(new Error("no pinned address"), { code: "ENOTFOUND" }), "");
    if (all) done(null, answers);
    else done(null, first.address, first.family);
  }) as unknown as LookupFunction;
}

export interface SubmitInput {
  validationId: unknown;
  contentHash: unknown;
  idempotencyKey?: unknown;
}

interface CallScope {
  run: RunRecord;
  connector: ConnectorRegistration;
}

export class ConnectorProxy {
  private readonly clock: () => Date;
  /** Submits on their way to the connector, so a concurrent repeat waits instead of executing. */
  private readonly inFlight = new Map<string, Promise<ConnectorSubmitResponse>>();

  constructor(private readonly deps: ConnectorProxyDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  private scope(runId: RunId, ref: string): CallScope {
    const run = this.deps.runs.mustGet(runId);
    const bot = this.deps.bots.mustGet(run.botId);
    return { run, connector: this.deps.registry.resolve(bot.workspaceId, ref) };
  }

  /** The stored validation, for the PreToolUse hook's tier decision. Not a tool call. */
  validation(runId: RunId, ref: string, validationId: string): StoredConnectorValidation {
    const { connector } = this.scope(runId, ref);
    const v = this.deps.validations.get(connector.id, validationId);
    if (!v)
      throw new DeskmatesError(
        "connector_validation_missing",
        "no such validation on this connector",
        {
          connectorId: connector.id,
          validationId,
        },
      );
    return v;
  }

  describe(runId: RunId, ref: string): Promise<ConnectorCapabilities> {
    const s = this.scope(runId, ref);
    return this.attributed(s, "describe", {}, async () =>
      parseConnectorCapabilities(await this.call(s.connector, "POST", "/describe", {})),
    );
  }

  validate(runId: RunId, ref: string, submission: unknown): Promise<StoredConnectorValidation> {
    const s = this.scope(runId, ref);
    if (submission === undefined)
      throw new DeskmatesError("validation", "a submission is required", { field: "submission" });
    const hash = contentHash(submission);
    return this.attributed(
      s,
      "validate",
      { contentHash: hash },
      async () => {
        const result = parseConnectorValidation(
          await this.call(s.connector, "POST", "/validate", { submission, contentHash: hash }),
        );
        if (result.contentHash !== hash)
          throw new DeskmatesError("connector_protocol", "connector hashed another body", {
            expected: hash,
            got: result.contentHash,
          });
        const now = this.clock();
        return this.deps.validations.record({
          ...result,
          connectorId: s.connector.id,
          runId: s.run.id,
          botId: s.run.botId,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.deps.validationTtlSeconds * 1000).toISOString(),
        });
      },
      (v) => ({ validationId: v.validationId, effect: v.effect, valid: v.valid }),
    );
  }

  submit(runId: RunId, ref: string, input: SubmitInput): Promise<ConnectorSubmitResponse> {
    const s = this.scope(runId, ref);
    const { validationId, contentHash: hash } = input;
    if (typeof validationId !== "string" || validationId === "")
      throw new DeskmatesError("validation", "validationId is required", { field: "validationId" });
    if (!isContentHash(hash))
      throw new DeskmatesError("validation", "contentHash must be a sha256 hex digest", {
        field: "contentHash",
      });
    if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== "string")
      throw new DeskmatesError("validation", "idempotencyKey must be a string", {
        field: "idempotencyKey",
      });
    // Without a key the validation is the unit of idempotency: submitting it twice executes once.
    const idempotencyKey = input.idempotencyKey || validationId;
    return this.attributed(
      s,
      "submit",
      { validationId, contentHash: hash, idempotencyKey },
      () => this.submitOnce(s, validationId, hash, idempotencyKey),
      (r) => ({ receiptId: r.receipt.receiptId, duplicate: r.duplicate }),
    );
  }

  private submitOnce(
    s: CallScope,
    validationId: string,
    hash: string,
    idempotencyKey: string,
  ): Promise<ConnectorSubmitResponse> {
    const existing = this.deps.receipts.findByIdempotency(s.connector.id, hash, idempotencyKey);
    if (existing) return Promise.resolve({ receipt: existing, duplicate: true });
    const key = `${s.connector.id}\u0000${hash}\u0000${idempotencyKey}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending.then((r) => ({ receipt: r.receipt, duplicate: true }));
    this.checkBinding(s, validationId, hash);
    const execution = (async (): Promise<ConnectorSubmitResponse> => {
      const receipt = parseConnectorReceipt(
        await this.call(s.connector, "POST", "/submit", {
          validationId,
          contentHash: hash,
          idempotencyKey,
        }),
      );
      if (receipt.contentHash !== hash || receipt.idempotencyKey !== idempotencyKey)
        throw new DeskmatesError(
          "connector_protocol",
          "connector receipt names another submission",
          {
            contentHash: receipt.contentHash,
            idempotencyKey: receipt.idempotencyKey,
          },
        );
      const stored = this.deps.receipts.get(s.connector.id, receipt.receiptId);
      if (stored) return { receipt: stored, duplicate: true };
      const record = this.deps.receipts.create(
        {
          connectorId: s.connector.id,
          workspaceId: s.connector.workspaceId,
          runId: s.run.id,
          botId: s.run.botId,
        },
        receipt,
      );
      return { receipt: record, duplicate: false };
    })();
    this.inFlight.set(key, execution);
    return execution.finally(() => this.inFlight.delete(key));
  }

  /** ADR-0012 item 5: submit only a live, valid validation of this connector and this hash. */
  private checkBinding(s: CallScope, validationId: string, hash: string): void {
    const details = { connectorId: s.connector.id, validationId };
    const v = this.deps.validations.get(s.connector.id, validationId);
    if (!v) {
      const others = this.deps.validations.otherConnectorsWith(s.connector.id, validationId);
      if (others.length > 0)
        throw new DeskmatesError(
          "connector_validation_wrong_connector",
          "the validation belongs to another connector",
          { ...details, validatedOn: others },
        );
      throw new DeskmatesError(
        "connector_validation_missing",
        "submit needs a prior validation on this connector",
        details,
      );
    }
    if (v.contentHash !== hash)
      throw new DeskmatesError(
        "connector_hash_mismatch",
        "the submitted content hash is not the validated one",
        { ...details, validatedHash: v.contentHash, submittedHash: hash },
      );
    if (this.clock().toISOString() >= v.expiresAt)
      throw new DeskmatesError(
        "connector_validation_stale",
        "the validation has expired; validate again",
        {
          ...details,
          expiresAt: v.expiresAt,
        },
      );
    if (!v.valid)
      throw new DeskmatesError("connector_validation_invalid", "the validation found errors", {
        ...details,
        errors: v.errors,
      });
  }

  status(runId: RunId, ref: string, receiptId: string): Promise<ConnectorReceiptRecord> {
    return this.readBack(runId, ref, receiptId, "status");
  }

  receipt(runId: RunId, ref: string, receiptId: string): Promise<ConnectorReceiptRecord> {
    return this.readBack(runId, ref, receiptId, "receipt");
  }

  /**
   * Asks the connector for the receipt as it is now and appends a version when it moved. The
   * answer is always the Gateway's stored record: a receipt submitted elsewhere is unknown here.
   */
  private readBack(
    runId: RunId,
    ref: string,
    receiptId: string,
    op: "status" | "receipt",
  ): Promise<ConnectorReceiptRecord> {
    const s = this.scope(runId, ref);
    return this.attributed(
      s,
      op,
      { receiptId },
      async () => {
        const stored = this.deps.receipts.get(s.connector.id, receiptId);
        if (!stored)
          throw new DeskmatesError("not_found", "no receipt of this connector has that id", {
            connectorId: s.connector.id,
            receiptId,
          });
        const path = `/${op}/${encodeURIComponent(receiptId)}`;
        const fresh: ConnectorReceipt = parseConnectorReceipt(
          await this.call(s.connector, "GET", path),
        );
        if (fresh.receiptId !== receiptId || fresh.contentHash !== stored.contentHash)
          throw new DeskmatesError("connector_protocol", "connector answered for another receipt", {
            receiptId,
          });
        return this.deps.receipts.addVersionIfNewer(s.connector.id, fresh);
      },
      (r) => ({
        contentHash: r.contentHash,
        validationId: r.validationId,
        status: r.current.status,
      }),
    );
  }

  private async call(
    connector: ConnectorRegistration,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const endpoint = this.deps.registry.endpoint(connector.id);
    // A public connector's name is resolved once, every address checked, and the connection pinned
    // to exactly those addresses, so a DNS answer that changes in between (rebinding) is never
    // used. A private connector is platform-registered and reached as configured.
    const pinned = connector.publicUrl
      ? pinnedDispatcher(await this.requirePublicTarget(connector, endpoint.url))
      : undefined;
    let res: Response;
    try {
      res = await this.deps.fetch(`${endpoint.url}${path}`, {
        ...(pinned ? ({ dispatcher: pinned } as unknown as RequestInit) : {}),
        // A redirect could bounce the call to a host the URL check never saw.
        redirect: "error",
        method,
        headers: {
          accept: "application/json",
          ...(endpoint.credential ? { authorization: `Bearer ${endpoint.credential}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? CONNECTOR_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      void pinned?.close();
      // The endpoint stays out of the error: it is a secret and this message reaches the model.
      throw new DeskmatesError("connector_unavailable", "the connector could not be reached", {
        connectorId: connector.id,
        reason: err instanceof Error ? err.name : "error",
      });
    }
    try {
      if (!res.ok) {
        // An unread body keeps its socket checked out of the shared dispatcher until GC.
        await res.body?.cancel().catch(() => undefined);
        throw new DeskmatesError(
          "connector_unavailable",
          `the connector answered HTTP ${res.status}`,
          {
            connectorId: connector.id,
            status: res.status,
          },
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof DeskmatesError) throw err;
      throw new DeskmatesError(
        "connector_protocol",
        "connector answered with a body that is not JSON",
        {
          connectorId: connector.id,
        },
      );
    } finally {
      void pinned?.close();
    }
  }

  /**
   * A public connector URL was a public hostname when it was registered; its name may resolve to
   * a private, loopback or metadata address now. Every resolved address must be public; the call
   * is then pinned to them (`pinnedDispatcher`). Returns the checked addresses.
   */
  private async requirePublicTarget(
    connector: ConnectorRegistration,
    url: string,
  ): Promise<string[]> {
    const hostname = new URL(url).hostname;
    const lookup =
      this.deps.lookup ??
      (async (host: string) =>
        (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address));
    let addresses: string[];
    try {
      addresses = await lookup(hostname);
    } catch {
      addresses = [];
    }
    const allowed = this.deps.addressAllowed ?? isPublicAddress;
    if (addresses.length === 0 || !addresses.every(allowed))
      throw new DeskmatesError("connector_unavailable", "the connector could not be reached", {
        connectorId: connector.id,
        reason: "address_not_public",
      });
    return addresses;
  }

  /** Wraps one connector operation in its `tool_call` / `tool_result` ledger pair (item 7). */
  private async attributed<T>(
    s: CallScope,
    op: ConnectorOperation,
    ids: Record<string, unknown>,
    fn: () => Promise<T>,
    resultIds: (result: T) => Record<string, unknown> = () => ({}),
  ): Promise<T> {
    const base = {
      source: "connector_proxy",
      toolName: `mcp__deskmates__connector_${op}`,
      operation: op,
      connectorId: s.connector.id,
      connectorName: s.connector.name,
      botId: s.run.botId,
      ...ids,
    };
    this.deps.events.append({ runId: s.run.id, kind: "tool_call", payload: base });
    try {
      const result = await fn();
      this.deps.events.append({
        runId: s.run.id,
        kind: "tool_result",
        payload: { ...base, ...resultIds(result), isError: false, result },
      });
      return result;
    } catch (err) {
      this.deps.events.append({
        runId: s.run.id,
        kind: "tool_result",
        payload: {
          ...base,
          isError: true,
          error: isDeskmatesError(err)
            ? { code: err.code, message: err.message, details: err.details }
            : { code: "internal", message: "connector call failed" },
        },
      });
      throw err;
    }
  }
}
