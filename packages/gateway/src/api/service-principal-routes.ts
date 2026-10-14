// Service principal management (ADR-0022 amendment 2). The root (amendment 6 W2) creates, lists,
// disables and rotates that tenant's machine identities. The route guard resolves `:id` to the
// request's tenant first, so another tenant's principal is the uniform 404; the store's own
// queries are scoped by tenant as well. A token appears in a response exactly once.

import type { IssuedServicePrincipalView, ServicePrincipalView } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { actorLabel } from "../auth/principal.js";
import { servicePrincipalView } from "../auth/service-principals.js";
import type { GatewayContext } from "../context.js";
import { requestRole, requestTenant, roleAtLeast } from "./route-policy.js";
import { asRecord } from "./validate.js";

export function registerServicePrincipalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const auth = ctx.auth;

  app.get("/api/service-principals", async (request) => ({
    servicePrincipals: auth.servicePrincipals
      .list(requestTenant(request))
      .map(servicePrincipalView) satisfies ServicePrincipalView[],
  }));

  app.post("/api/service-principals", async (request, reply) => {
    const body = asRecord(request.body);
    // The guard admits the root only (amendment 6 W2); it creates at most an `admin` principal
    // (ADR-0022 amendment 1 A10), and `role: "member"` lowers it.
    const { record, token } = auth.servicePrincipals.create(
      requestTenant(request),
      {
        name: body.name,
        ...(body.role === undefined ? {} : { role: body.role }),
        dailyUsdCap: body.dailyUsdCap,
      },
      actorLabel(request.principal),
      roleAtLeast(requestRole(request), "admin") ? "admin" : "member",
    );
    const issued: IssuedServicePrincipalView = {
      servicePrincipal: servicePrincipalView(record),
      token,
    };
    return reply.code(201).send(issued);
  });

  app.post<{ Params: { id: string } }>("/api/service-principals/:id/disable", async (request) => ({
    servicePrincipal: servicePrincipalView(
      auth.disableServicePrincipal(
        requestTenant(request),
        request.params.id,
        actorLabel(request.principal),
      ),
    ),
  }));

  app.post<{ Params: { id: string } }>(
    "/api/service-principals/:id/rotate",
    async (request): Promise<IssuedServicePrincipalView> =>
      auth.rotateServicePrincipal(
        requestTenant(request),
        request.params.id,
        actorLabel(request.principal),
      ),
  );
}
