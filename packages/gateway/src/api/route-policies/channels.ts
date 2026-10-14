// Operator route policies for channels; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, authenticated, member } from "./policy.js";

export const channelsRoutePolicies: PolicyTable = {
  // Release-bundled channels: everyone reads status; Admins change the workspace connection.
  "GET /api/channels": authenticated,
  "GET /api/workspaces/:workspaceId/channels": member({ params: { workspaceId: "workspace" } }),
  "POST /api/workspaces/:workspaceId/channels/:pluginId/connect": admin({
    params: { workspaceId: "workspace" },
    body: { botId: "bot" },
    handlerCheck: "pluginId is resolved against the release-bundled channel catalog",
  }),
  "POST /api/workspaces/:workspaceId/channels/:pluginId/commands/:command": admin({
    params: { workspaceId: "workspace" },
    handlerCheck:
      "pluginId is resolved against the release-bundled channel catalog and command against the fixed command set",
  }),
};
