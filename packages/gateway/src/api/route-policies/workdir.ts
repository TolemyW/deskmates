// Operator route policies for working-directory settings (ADR-0036 decision 1); aggregated in
// `../route-policy.ts`.

import { type PolicyTable, admin, member } from "./policy.js";

export const workdirRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/workdir": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/workdir": admin({ params: { id: "workspace" } }),
};
