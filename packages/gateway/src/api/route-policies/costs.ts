// Operator route policies for costs; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, member } from "./policy.js";

export const costsRoutePolicies: PolicyTable = {
  // Workspace monetary budget (ADR-0032 decisions 1 and 7): Admins set limits and continue.
  "GET /api/budgets": member({ scopedList: true }),
  "PUT /api/budgets/:workspaceId": admin({ params: { workspaceId: "workspace" } }),
  "POST /api/budgets/:workspaceId/continue": admin({ params: { workspaceId: "workspace" } }),
  "GET /api/costs": member({
    query: { botId: "bot", workspaceId: "workspace" },
    scopedList: true,
  }),
  "GET /api/costs/ranking": member({
    query: { botId: "bot", workspaceId: "workspace" },
    scopedList: true,
  }),
  "GET /api/costs/rows": member({
    query: { botId: "bot", workspaceId: "workspace" },
    scopedList: true,
  }),
  "GET /api/cost-alert-rules": member({ scopedList: true }),
  "POST /api/cost-alert-rules": admin({ body: { botId: "bot" } }),
  "DELETE /api/cost-alert-rules/:id": admin({ params: { id: "costAlertRule" } }),
  "GET /api/cost-alerts": member({ scopedList: true }),
  "POST /api/cost-alerts/:id/acknowledge": member({ params: { id: "costAlert" } }),
};
