// Operator route policies for browser; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, member } from "./policy.js";

export const browserRoutePolicies: PolicyTable = {
  "POST /api/workspaces/:id/takeover": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/takeover/open-screen": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/handback": member({ params: { id: "workspace" } }),
  "GET /api/bots/:id/screen": member({ params: { id: "bot" } }),
  "POST /api/bots/:id/screen/start": member({ params: { id: "bot" } }),
  "POST /api/bots/:id/screen/access": member({ params: { id: "bot" } }),
  "POST /api/screen-access/:id/close": member({
    handlerCheck: "a desktop ticket closes only for the tenant and session that opened it",
  }),
  // Not a scoped list: the workspace id is required (the handler refuses a call without it), so
  // the guard resolves it like a path parameter and the tenant walk covers the route.
  "GET /api/capacity": member({ query: { workspaceId: "workspace" } }),
};
