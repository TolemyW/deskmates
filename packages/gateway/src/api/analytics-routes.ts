// The analytics relay (ADR-0046 amendment 1 decisions 13 and 14): `/analytics` and
// `/analytics/*` on the operator listener, forwarded to the Grafana at
// `OBSERVABILITY_GRAFANA_URL` on the host loopback. Admission is the operator scope's own:
// `operator-auth.ts` resolves the browser session and checks `Origin` (these two patterns are its
// fixed exemption from the CSRF header, which Grafana's frontend cannot send), and the route
// policy `root_session` admits the root's own session only. With no Grafana configured the routes
// answer the uniform 404. WebSocket upgrades never reach a route; Live is off (decision 15).

import { DeskmatesError } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import {
  ANALYTICS_BOUNDS,
  ANALYTICS_METHODS,
  ANALYTICS_ROUTES,
  type AnalyticsBounds,
  relayToGrafana,
} from "./analytics-relay.js";

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  bounds: AnalyticsBounds = ANALYTICS_BOUNDS,
): void {
  const configured = ctx.config.observabilityGrafanaUrl;
  const upstream = configured === undefined ? undefined : new URL(configured);
  // A child scope, so that its body handling stays its own: every request body passes to Grafana
  // as the unread stream it arrived as, whatever its content type. The operator scope's
  // authentication and route-policy hooks still run first.
  app.register(async (relay) => {
    relay.removeAllContentTypeParsers();
    relay.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    for (const url of ANALYTICS_ROUTES)
      relay.route({
        method: [...ANALYTICS_METHODS],
        url,
        handler: async (request, reply) => {
          if (upstream === undefined) throw new DeskmatesError("not_found", "Not found");
          return relayToGrafana(request, reply, upstream, bounds);
        },
      });
  });
}
