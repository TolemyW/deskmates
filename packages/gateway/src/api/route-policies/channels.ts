// Operator route policies for channels; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, authenticated, member } from "./policy.js";

const CONNECTION =
  "connectionId is resolved inside the guarded workspace (ChannelStore.mustGetInWorkspace)";

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
  // ADR-0047: connection-addressed lifecycle, rebind and the sender blocklist; Admins only.
  "DELETE /api/workspaces/:workspaceId/channel-connections/:connectionId/blocks/:senderId": admin({
    params: { workspaceId: "workspace" },
    handlerCheck: CONNECTION,
  }),
  "GET /api/workspaces/:workspaceId/channel-connections/:connectionId/blocks": admin({
    params: { workspaceId: "workspace" },
    handlerCheck: CONNECTION,
  }),
  "POST /api/workspaces/:workspaceId/channel-connections/:connectionId/blocks": admin({
    params: { workspaceId: "workspace" },
    handlerCheck: CONNECTION,
  }),
  "POST /api/workspaces/:workspaceId/channel-connections/:connectionId/command-menu": admin({
    params: { workspaceId: "workspace" },
    handlerCheck: CONNECTION,
  }),
  "POST /api/workspaces/:workspaceId/channel-connections/:connectionId/commands/:command": admin({
    params: { workspaceId: "workspace" },
    handlerCheck: `${CONNECTION}; command against the fixed command set`,
  }),
  "POST /api/workspaces/:workspaceId/channel-connections/:connectionId/rebind": admin({
    params: { workspaceId: "workspace" },
    body: { botId: "bot" },
    handlerCheck: CONNECTION,
  }),
};
