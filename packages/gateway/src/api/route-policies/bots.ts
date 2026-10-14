// Operator route policies for bots; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, guest, member } from "./policy.js";

export const botsRoutePolicies: PolicyTable = {
  "GET /api/bots": guest({
    query: { workspaceId: "workspace" },
    scopedList: true,
    handlerCheck: "listed only from the caller's workspaces",
  }),
  "POST /api/bots": admin({ body: { workspaceId: "workspace" } }),
  "GET /api/bots/:id": guest({ params: { id: "bot" } }),
  "POST /api/bots/:id/archive": admin({ params: { id: "bot" } }),
  "POST /api/bots/:id/restore": admin({ params: { id: "bot" } }),
  "DELETE /api/bots/:id": admin({ params: { id: "bot" } }),
  // Opening a bot's canonical private chat may create or adopt it, which is an Admin's. A Member
  // or Guest gets one that exists already (ADR-0022 amendment 6).
  "POST /api/bots/:id/private-chat": guest({
    params: { id: "bot" },
    handlerCheck:
      "below Admin (Member, Guest, member principal) gets an existing canonical chat only, never creates one",
  }),
  "POST /api/bots/:id/welcome": admin({ params: { id: "bot" } }),
  "PATCH /api/bots/:id": admin({ params: { id: "bot" } }),
  "POST /api/bots/:id/webhook-token": admin({ params: { id: "bot" } }),
  "GET /api/bots/:id/soul": member({ params: { id: "bot" } }),
  "PATCH /api/bots/:id/soul": admin({ params: { id: "bot" } }),
  "GET /api/bots/:id/soul/export": member({ params: { id: "bot" } }),
  "GET /api/bots/:id/memory": member({ params: { id: "bot" } }),
  "PATCH /api/bots/:id/memory": admin({ params: { id: "bot" } }),
  "GET /api/bots/:id/memory/export": member({ params: { id: "bot" } }),
  "POST /api/bots/:id/memory/consolidate": admin({ params: { id: "bot" } }),
};
