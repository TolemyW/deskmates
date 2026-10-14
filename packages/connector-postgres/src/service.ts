// The connector's HTTP service: the ADR-0012 contract over one PostgreSQL-protocol database.
// POST /describe and POST /validate never touch the database. POST /submit binds to a live valid
// validation of the same content hash, is idempotent on (contentHash, idempotencyKey), records
// the receipt `accepted` and queues the batch; GET /status and GET /receipt read receipts back.

import { randomUUID } from "node:crypto";
import { type ConnectorValidationResult, isContentHash } from "@deskmates/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import type { BatchRunner } from "./batch-runner.js";
import { bearerMatches } from "./bearer-auth.js";
import { capabilities } from "./capabilities.js";
import type { ConnectorConfig } from "./config.js";
import { contentHash } from "./content-hash.js";
import { sendError } from "./http-error.js";
import type { ReceiptBody, ReceiptStore } from "./receipt-store.js";
import { validateBatch } from "./validate-batch.js";
import { ValidationStore } from "./validation-store.js";

export interface ServiceOptions {
  config: Pick<ConnectorConfig, "token" | "name" | "limits">;
  store: ReceiptStore;
  runner: BatchRunner;
  logger?: boolean;
  clock?: () => number;
  newId?: () => string;
}

/** Fastify's request log never carries headers; the redaction is a second guard. */
const LOGGER = { redact: ["req.headers.authorization"] };

/** /status is the receipt without the per-case results (they are also in `detail` when final). */
function statusOf(body: ReceiptBody): Omit<ReceiptBody, "cases"> {
  const { cases: _cases, ...rest } = body;
  return rest;
}

export function buildService(opts: ServiceOptions): FastifyInstance {
  const { config, store, runner } = opts;
  const newId = opts.newId ?? (() => randomUUID().replaceAll("-", ""));
  const app = Fastify({ logger: opts.logger ? LOGGER : false });
  const validations = new ValidationStore(config.limits.validationTtlSeconds, opts.clock);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz") return;
    if (!bearerMatches(req.headers.authorization, config.token))
      return sendError(reply, 401, "token_rejected", "a valid bearer token is required");
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/describe", async () => capabilities(config.name, config.limits));

  app.post("/validate", async (req, reply) => {
    const body = req.body as { submission?: unknown } | undefined;
    if (typeof body !== "object" || body === null || body.submission === undefined)
      return sendError(reply, 400, "validation", "the body must carry a submission", {
        field: "submission",
      });
    const hash = contentHash(body.submission);
    const checked = validateBatch(body.submission, config.limits);
    const result: ConnectorValidationResult = {
      validationId: `val_${newId()}`,
      contentHash: hash,
      valid: checked.valid,
      effect: checked.effect,
      summary: checked.summary,
      errors: checked.errors,
    };
    validations.put({ ...result, ...(checked.batch ? { batch: checked.batch } : {}) });
    return result;
  });

  app.post("/submit", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { validationId, contentHash: hash, idempotencyKey: rawKey } = body;
    if (typeof validationId !== "string" || validationId === "")
      return sendError(reply, 400, "validation", "validationId is required", {
        field: "validationId",
      });
    if (!isContentHash(hash))
      return sendError(reply, 400, "validation", "contentHash must be a sha256 hex digest", {
        field: "contentHash",
      });
    if (rawKey !== undefined && (typeof rawKey !== "string" || rawKey === ""))
      return sendError(reply, 400, "validation", "idempotencyKey must be a non-empty string", {
        field: "idempotencyKey",
      });
    // Without a key the validation is the unit of idempotency, as in the Gateway's proxy.
    const idempotencyKey = rawKey ?? validationId;

    // A repeat returns the existing receipt and executes nothing, whatever became of the
    // validation since (expired, forgotten by a restart).
    const existing = store.findByKey(hash, idempotencyKey);
    if (existing !== undefined) return store.mustGet(existing);

    const details = { validationId };
    const found = validations.lookup(validationId);
    if (found.status === "missing")
      return sendError(
        reply,
        404,
        "connector_validation_missing",
        "submit needs a prior validation on this connector",
        details,
      );
    const v = found.validation;
    if (v.contentHash !== hash)
      return sendError(
        reply,
        409,
        "connector_hash_mismatch",
        "the submitted content hash is not the validated one",
        { ...details, validatedHash: v.contentHash, submittedHash: hash },
      );
    if (found.status === "stale")
      return sendError(
        reply,
        409,
        "connector_validation_stale",
        "the validation has expired; validate again",
        details,
      );
    if (!v.valid || !v.batch)
      return sendError(reply, 409, "connector_validation_invalid", "the validation found errors", {
        ...details,
        errors: v.errors,
      });

    // findByKey and accept run in one synchronous stretch, so two concurrent submits of the same
    // key cannot both pass the check; the UNIQUE constraint is the second guard.
    const receipt = store.accept({
      receiptId: `rcpt_${newId()}`,
      contentHash: hash,
      idempotencyKey,
      validationId,
      batch: v.batch,
      summary: `${v.summary}; accepted, queued`,
    });
    runner.enqueue(receipt.receiptId);
    return receipt;
  });

  app.get<{ Params: { receiptId: string } }>("/status/:receiptId", async (req, reply) => {
    const body = store.get(req.params.receiptId);
    if (!body) return sendError(reply, 404, "not_found", "no receipt has that id");
    return statusOf(body);
  });

  app.get<{ Params: { receiptId: string } }>("/receipt/:receiptId", async (req, reply) => {
    const body = store.get(req.params.receiptId);
    if (!body) return sendError(reply, 404, "not_found", "no receipt has that id");
    return body;
  });

  return app;
}
