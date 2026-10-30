// Operator route policies for the workspace credential vault (ADR-0045 decision 2): every Member
// reads metadata, an Owner or Admin of the workspace maintains entries; aggregated in
// `../route-policy.ts`.

import { type PolicyTable, admin, member } from "./policy.js";

const ENTRY_CHECK = "the vault entry is looked up inside the guarded workspace; another's is a 404";

export const vaultRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/vault": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/vault": admin({ params: { id: "workspace" } }),
  "PATCH /api/workspaces/:id/vault/:entryId": admin({
    params: { id: "workspace" },
    handlerCheck: ENTRY_CHECK,
  }),
  "PUT /api/workspaces/:id/vault/:entryId/value": admin({
    params: { id: "workspace" },
    handlerCheck: ENTRY_CHECK,
  }),
  "PUT /api/workspaces/:id/vault/:entryId/requests": admin({
    params: { id: "workspace" },
    handlerCheck: ENTRY_CHECK,
  }),
  "DELETE /api/workspaces/:id/vault/:entryId": admin({
    params: { id: "workspace" },
    handlerCheck: ENTRY_CHECK,
  }),
};
