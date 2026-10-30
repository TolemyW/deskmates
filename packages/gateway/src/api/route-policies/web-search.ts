// Operator route policies for the `web_search` switch (ADR-0049 decision 4); aggregated in
// `../route-policy.ts`.

import { type PolicyTable, admin, member } from "./policy.js";

export const webSearchRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/web-search": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/web-search": admin({ params: { id: "workspace" } }),
};
