// Operator route policies for the analytics relay to Grafana (ADR-0046 amendment 1 decision 13);
// aggregated in `../route-policy.ts` (ADR-0022 P2). Grafana shows every workspace, and the owner
// asked that only the root, signed in to Deskmates, see it: the root's own browser session, never
// a bearer credential.

import { ANALYTICS_METHODS, ANALYTICS_ROUTES } from "../analytics-relay.js";
import { type PolicyTable, rootSession } from "./policy.js";

export const analyticsRoutePolicies: PolicyTable = Object.fromEntries(
  ANALYTICS_ROUTES.flatMap((url) =>
    ANALYTICS_METHODS.map((method) => [`${method} ${url}`, rootSession] as const),
  ),
);
