// Operator route policies for installation; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, authenticated, platform } from "./policy.js";

export const installationRoutePolicies: PolicyTable = {
  "GET /api/prices": authenticated,
  "PUT /api/prices": platform,
  "GET /api/config": authenticated,
  "GET /api/runtime": platform,
};
