// Error answers of the HTTP contract. The body is `{ error: { code, message, details } }` with a
// code from contracts' DeskmatesErrorCode, the same vocabulary the Gateway uses for connector errors.

import type { DeskmatesErrorCode } from "@deskmates/contracts";
import type { FastifyReply } from "fastify";

export interface ErrorBody {
  error: { code: DeskmatesErrorCode; message: string; details: Record<string, unknown> };
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: DeskmatesErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): FastifyReply {
  const body: ErrorBody = { error: { code, message, details } };
  return reply.code(status).send(body);
}
