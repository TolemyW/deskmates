// Host resources (ADR-0006 amendment 5, issue #14): the root reads what the sandbox provider owns
// on its host, classified against the database, and acts on one finding at a time. The
// classification and the actions live in `../host-resources/host-resources.ts`.

import { DeskmatesError, type HostResourceAction } from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { actOnHostResource, hostResourceReport } from "../host-resources/host-resources.js";
import { requestActorId } from "./actor.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";

function findingIdOf(body: Record<string, unknown>): string {
  const id = body.findingId;
  if (typeof id !== "string" || id.length === 0 || id.length > 512)
    throw new DeskmatesError("validation", "findingId is required");
  return id;
}

export function registerHostResourceRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  // Decision 12: listing changes nothing.
  app.get("/api/runtime/resources", async () => hostResourceReport(ctx));

  const act = (action: HostResourceAction) => async (request: FastifyRequest) => {
    const body = asRecord(request.body);
    return actOnHostResource(ctx, action, findingIdOf(body), {
      by: requestActorId(request, body),
      tenantId: requestTenant(request),
    });
  };
  // Decision 13: one action per finding, each an audit row.
  app.post("/api/runtime/resources/reattach", act("reattach"));
  app.post("/api/runtime/resources/remove", act("remove"));
}
