// Operator route policies for workspaces; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, guest } from "./policy.js";

export const workspacesRoutePolicies: PolicyTable = {
  "GET /api/workspaces": guest({
    scopedList: true,
    handlerCheck: "lists only the workspaces the caller belongs to",
  }),
  "POST /api/workspaces": admin(),
  "GET /api/workspaces/:id": guest({ params: { id: "workspace" } }),
  "PATCH /api/workspaces/:id": admin({ params: { id: "workspace" } }),
  // ADR-0051 decision 1: which bot is the workspace's default bot.
  "PUT /api/workspaces/:id/default-bot": admin({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/restart": admin({ params: { id: "workspace" } }),
  "GET /api/workspaces/:id/restart-preflight": admin({ params: { id: "workspace" } }),
  "GET /api/workspace-directory": guest({
    scopedList: true,
    handlerCheck: "lists only the workspaces the caller belongs to; archived ones to their Admins",
  }),
  "PUT /api/workspaces/:id/pin": guest({
    params: { id: "workspace" },
    handlerCheck: "a person's own pin; other principals have none",
  }),
  "DELETE /api/workspaces/:id/pin": guest({
    params: { id: "workspace" },
    handlerCheck: "a person's own pin; other principals have none",
  }),
  "GET /api/trash": admin({ scopedList: true }),
  "POST /api/workspaces/:id/archive": admin({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/restore": admin({ params: { id: "workspace" } }),
  "DELETE /api/workspaces/:id": admin({ params: { id: "workspace" } }),
};
