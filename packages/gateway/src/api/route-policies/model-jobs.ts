// Operator route policies for short model jobs (ADR-0023 amendment 1); aggregated in
// `../route-policy.ts` (ADR-0022 P2). Reading a capability or a proposal is a Member's; anything
// that queues a model job or writes SOUL is an Admin's, like the SOUL edit itself.

import { type PolicyTable, admin, member } from "./policy.js";

export const modelJobsRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/model-capabilities": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/model-capabilities/vision/probe": admin({
    params: { id: "workspace" },
  }),
  "POST /api/bots/:id/soul-proposals": admin({ params: { id: "bot" } }),
  "GET /api/bots/:id/soul-proposals/:proposalId": member({
    params: { id: "bot" },
    handlerCheck: "the proposal must belong to the bot in the path",
  }),
  "POST /api/bots/:id/soul-proposals/:proposalId/apply": admin({
    params: { id: "bot" },
    handlerCheck: "the proposal must belong to the bot in the path",
  }),
  "POST /api/bots/:id/soul-proposals/:proposalId/discard": admin({
    params: { id: "bot" },
    handlerCheck: "the proposal must belong to the bot in the path",
  }),
};
