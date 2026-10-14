// Maps DeskmatesError codes to HTTP statuses and a stable JSON body `{code, message, details}`.

import {
  type DeskmatesErrorCode,
  INTEGRATION_ERROR_STATUS,
  isDeskmatesError,
} from "@deskmates/contracts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const STATUS_BY_CODE: Readonly<Record<DeskmatesErrorCode, number>> = {
  not_found: 404,
  invalid_transition: 409,
  lane_busy: 409,
  // 429, not 409: the queue is full *now* and the sender should retry later, which is what a
  // webhook delivery agent does with 429 and not with a conflict.
  queue_full: 429,
  egress_blocked: 403,
  browser_held_by_human: 409,
  relay_cap_breached: 409,
  turn_budget_breached: 409,
  sandbox_unavailable: 503,
  token_rejected: 401,
  rate_limited: 429,
  budget_exceeded: 429,
  // A Continue while the workspace budget is still spent (ADR-0032 decision 7).
  budget_exhausted: 409,
  validation: 400,
  forbidden: 403,
  model_not_selected: 403,
  payload_too_large: 413,
  // The workspace disk is full while writing an upload (ADR-0014 amendment A5 decision 30).
  storage_exhausted: 507,
  invitation_unusable: 410,
  memory_rule_refused: 403,
  // A Web post to a channel-owned thread: the caller is known, the surface is the wrong one.
  channel_thread_read_only: 403,
  // The connector is the Gateway's upstream: an unreachable one or a malformed answer is a bad
  // gateway, not the caller's fault.
  connector_unavailable: 502,
  connector_protocol: 502,
  // A submit refused by the ADR-0012 item 5 binding: the request conflicts with stored state.
  connector_validation_missing: 409,
  connector_validation_stale: 409,
  connector_validation_wrong_connector: 409,
  connector_validation_invalid: 409,
  connector_hash_mismatch: 409,
  // Integration runtime (ADR-0013); the table lives with the codes in contracts.
  ...INTEGRATION_ERROR_STATUS,
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | Error, _request: FastifyRequest, reply: FastifyReply) => {
      if (isDeskmatesError(error)) {
        return reply
          .code(STATUS_BY_CODE[error.code])
          .send({ code: error.code, message: error.message, details: error.details });
      }
      const status =
        "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      if (status >= 500) {
        // An unmapped error at this point is a bug, a SQLite message or a JS runtime message.
        // None of them is for the caller: the sidecar runs untrusted page content, and schema
        // and file-path detail in an error body is free reconnaissance. The detail goes to the
        // log, where an operator can correlate it by time.
        app.log.error(error);
        return reply
          .code(status)
          .send({ code: "internal", message: "internal error", details: {} });
      }
      // 413 is Fastify's own: a webhook body past `WEBHOOK_BODY_MAX_BYTES` never reaches a
      // handler, so no DeskmatesError is raised for it.
      const code =
        status === 400
          ? "validation"
          : status === 404
            ? "not_found"
            : status === 413
              ? "body_too_large"
              : "internal";
      return reply.code(status).send({ code, message: error.message, details: {} });
    },
  );

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: "not_found",
      message: `route ${request.method} ${request.url} not found`,
      details: {},
    }),
  );
}
