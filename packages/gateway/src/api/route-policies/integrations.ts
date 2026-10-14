// Operator route policies for integrations; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, authenticated, member, platform } from "./policy.js";

export const integrationsRoutePolicies: PolicyTable = {
  "POST /api/connectors": admin({ body: { workspaceId: "workspace" } }),
  "GET /api/connectors": member({ query: { workspaceId: "workspace" }, scopedList: true }),
  "GET /api/connectors/:id": member({ params: { id: "connector" } }),
  "GET /api/integrations": authenticated,
  "GET /api/integrations/catalog": authenticated,
  "POST /api/integrations/providers": platform,
  "DELETE /api/integrations/providers/:service": platform,
  "PUT /api/integrations/providers/:service/oauth-app": platform,
  "GET /api/integrations/workspaces/:workspaceId/connections": member({
    params: { workspaceId: "workspace" },
  }),
  "POST /api/integrations/workspaces/:workspaceId/connections/api-key": admin({
    params: { workspaceId: "workspace" },
  }),
  "POST /api/integrations/workspaces/:workspaceId/connections/oauth/start": admin({
    params: { workspaceId: "workspace" },
  }),
  "DELETE /api/integrations/workspaces/:workspaceId/connections/:connectionId": admin({
    params: { workspaceId: "workspace", connectionId: "integrationConnection" },
  }),
  "GET /api/integrations/actions/overrides": authenticated,
  "PUT /api/integrations/actions/:actionId/override": platform,
};
