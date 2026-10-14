// `PATCH /auth/preferences` (issue #22): a signed-in person changes their own UI preferences,
// which `GET /auth/session` then reports. It is registered inside the operator authentication
// scope, so the session cookie, same-origin and CSRF checks apply as for any `/api` mutation, and
// its route policy is `authenticated`. Only a person has preferences: the operator credential and
// a service principal are refused with 400.

import { DeskmatesError, type UpdatePreferencesResponse } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { parsePreferencesChange } from "../auth/user-preferences.js";
import type { GatewayContext } from "../context.js";

export function registerPreferenceRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.patch("/auth/preferences", async (request, reply): Promise<UpdatePreferencesResponse> => {
    reply.header("cache-control", "no-store");
    const principal = request.principal;
    if (principal?.kind !== "user")
      throw new DeskmatesError("validation", "only a signed-in person has preferences", {
        reason: "no_user",
      });
    const change = parsePreferencesChange(request.body);
    return { preferences: ctx.auth.users.updatePreferences(principal.userId, change) };
  });
}
