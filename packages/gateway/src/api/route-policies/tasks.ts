// Operator route policies for tasks; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, member } from "./policy.js";

export const tasksRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:workspaceId/tasks": member({ params: { workspaceId: "workspace" } }),
  "POST /api/workspaces/:workspaceId/tasks": admin({
    params: { workspaceId: "workspace" },
  }),
  "GET /api/workspaces/:workspaceId/tasks/:id": member({ params: { workspaceId: "workspace" } }),
  "PATCH /api/workspaces/:workspaceId/tasks/:id": admin({
    params: { workspaceId: "workspace" },
  }),
  "POST /api/workspaces/:workspaceId/tasks/:id/accept": admin({
    params: { workspaceId: "workspace" },
  }),
  // ADR-0021 amendment 3: the explicit Run action and soft deletion.
  "POST /api/workspaces/:workspaceId/tasks/:id/run": admin({
    params: { workspaceId: "workspace" },
  }),
  "DELETE /api/workspaces/:workspaceId/tasks/:id": admin({
    params: { workspaceId: "workspace" },
  }),
  // Composite submit (issue #21): thread, task and must-reply message in one call, and the
  // lookup a client uses to find them again by its key.
  // A Member executes tasks (issue #116, ADR-0022 amendment 6 W5).
  "POST /api/workspaces/:id/submit": member({
    params: { id: "workspace" },
    body: { botId: "bot" },
  }),
  "GET /api/workspaces/:id/submissions": member({ params: { id: "workspace" } }),
};
