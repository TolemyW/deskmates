// Operator route policies for the opt-in native desktop tools (ADR-0048 decision 1); aggregated
// in `../route-policy.ts`.

import { type PolicyTable, admin, member } from "./policy.js";

export const desktopToolsRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/desktop-tools": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/desktop-tools": admin({ params: { id: "workspace" } }),
};
