// The one route that hands public Gateway configuration to the operator UI.

import type { OperatorConfig } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";

/**
 * `GET /api/config` → the configured model ids, so the UI can offer them as choices instead of
 * hardcoding a model name (AGENTS.md: "The model is configuration"), and `DESKMATES_RELEASE` so an
 * operator can see which release is running.
 *
 * It returns exactly the public keys of `OperatorConfig` and never spreads `ctx.config`: the rest
 * of that object is the upstream base URL and the upstream auth token, and this route is the only
 * thing that exposes configuration to the browser.
 */
export function registerConfigRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get(
    "/api/config",
    async (): Promise<OperatorConfig> => ({
      defaultModel: ctx.config.defaultModel,
      cheapModel: ctx.config.cheapModel,
      release: ctx.config.release ?? null,
      cronTimeZone: ctx.config.cronTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
}
