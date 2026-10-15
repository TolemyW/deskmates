// Operator route policies for published workspace apps (ADR-0035 decisions 1, 3, 8 and 9);
// aggregated in `../route-policy.ts`. Owner-decided 2026-10-14: every Member lists, publishes,
// opens and stops sharing; Guests do none of it.

import { type PolicyTable, member } from "./policy.js";

const SHARE_CHECK = "the publication must belong to the workspace in the path, else 404";

export const appSharesRoutePolicies: PolicyTable = {
  "DELETE /api/workspaces/:id/app-shares/:shareId": member({
    params: { id: "workspace" },
    handlerCheck: SHARE_CHECK,
  }),
  "GET /api/workspaces/:id/app-shares": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/app-shares": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/app-shares/:shareId/open": member({
    params: { id: "workspace" },
    handlerCheck: `${SHARE_CHECK}; a signed-in person only`,
  }),
};
