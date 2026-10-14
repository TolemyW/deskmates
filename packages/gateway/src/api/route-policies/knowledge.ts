// Operator route policies for knowledge; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, member, platform } from "./policy.js";

export const knowledgeRoutePolicies: PolicyTable = {
  "GET /api/knowledge": member({ scopedList: true }),
  "GET /api/knowledge/proposals": member({ scopedList: true }),
  "POST /api/knowledge/proposals": member(),
  "POST /api/knowledge/proposals/:id/review": admin({ params: { id: "knowledgeProposal" } }),
  "POST /api/knowledge/versions/cleanup": platform,
  "GET /api/knowledge/:id/history": member({ params: { id: "knowledgeDoc" } }),
  "GET /api/knowledge/:id": member({ params: { id: "knowledgeDoc" } }),
  "GET /api/knowledge/:id/export": member({ params: { id: "knowledgeDoc" } }),
  "PATCH /api/knowledge/:id": admin({ params: { id: "knowledgeDoc" } }),
};
