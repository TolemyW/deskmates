// Operator route policies for workspace execution limits; aggregated in `../route-policy.ts`
// (ADR-0005 amendment 5 decision 37, ADR-0016 amendment 2 decision 13).

import { type PolicyTable, admin, member } from "./policy.js";

export const limitsRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/limits": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/limits": admin({ params: { id: "workspace" } }),
};
