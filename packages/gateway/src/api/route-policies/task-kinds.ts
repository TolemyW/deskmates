// Operator route policies for task templates, the kind view and related tasks (ADR-0021
// amendment 4); aggregated in `../route-policy.ts`. Owners and Admins manage templates; Owners,
// Admins and Members read the views; Guests read neither (ADR-0022 amendment 6).

import { type PolicyTable, admin, member } from "./policy.js";

const ws = { params: { workspaceId: "workspace" } } as const;
// A template id is a built-in's or is looked up inside the guarded workspace; a kind is a key
// read only under it.
const template = { ...ws, handlerCheck: "TaskTemplateStore.mustGet(workspaceId, id)" } as const;
const kind = { ...ws, handlerCheck: "TaskKindView.stats(workspaceId, kind)" } as const;

export const taskKindsRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:workspaceId/task-templates": member(ws),
  "POST /api/workspaces/:workspaceId/task-templates": admin(ws),
  "PATCH /api/workspaces/:workspaceId/task-templates/:id": admin(template),
  "DELETE /api/workspaces/:workspaceId/task-templates/:id": admin(template),
  "GET /api/workspaces/:workspaceId/task-kinds": member(ws),
  "GET /api/workspaces/:workspaceId/task-kinds/:kind": member(kind),
  "GET /api/workspaces/:workspaceId/tasks/:id/related": member(ws),
};
