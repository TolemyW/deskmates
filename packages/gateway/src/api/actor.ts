// Who did it, for the ledger (ADR-0022 test plan AUDIT-01). A signed-in person is always
// `user:<id>` and a service principal always `service:<id>` (ADR-0022 amendment 2), whatever the
// request body says. Only the shared operator credential, the single-tenant machine bridge, may
// name its human in `authorId`: a chat channel adapter decides approvals on behalf of the sender
// it relays, and that is the label it has always recorded.

import type { FastifyRequest } from "fastify";
import { actorLabel } from "../auth/principal.js";
import { optionalString } from "./validate.js";

export function requestActorId(request: FastifyRequest, body: unknown): string {
  const principal = request.principal;
  if (principal?.kind === "user" || principal?.kind === "service") return actorLabel(principal);
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  return optionalString(record, "authorId") ?? "web";
}
