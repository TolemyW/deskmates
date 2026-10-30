// Operator route policies for installation; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, authenticated, platform } from "./policy.js";

export const installationRoutePolicies: PolicyTable = {
  "GET /api/prices": authenticated,
  "PUT /api/prices": platform,
  "GET /api/config": authenticated,
  "GET /api/runtime": platform,
  // ADR-0029 decisions 1 and 6: the upgrade drain and the restart breaker's operator action.
  "POST /api/runtime/drain": platform,
  "DELETE /api/runtime/drain": platform,
  "POST /api/runtime/platform-resume": platform,
};
