// Operator route policies for approvals; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, member } from "./policy.js";

export const approvalsRoutePolicies: PolicyTable = {
  "GET /api/approvals": member({
    query: { threadId: "thread", botId: "bot" },
    scopedList: true,
    handlerCheck: "listed only from the caller's workspaces, without other people's private chats",
  }),
  "GET /api/approvals/:id": member({ params: { id: "approval" } }),
  "POST /api/approvals/:id/decide": member({
    params: { id: "approval" },
    handlerCheck:
      "below Admin (Member or member principal) answers only approvals of the runs it started, allow_once or deny only; allow_always and an egress allow-this-site need an Admin",
  }),
  "GET /api/bots/:id/approval-rules": member({ params: { id: "bot" } }),
  "POST /api/bots/:id/approval-rules": admin({ params: { id: "bot" } }),
  "DELETE /api/approval-rules/:id": admin({ params: { id: "approvalRule" } }),
  // ADR-0002 amendment 6, D1: an Owner or Admin changes the approval mode; members read it.
  "GET /api/workspaces/:id/auto-approval": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/auto-approval": admin({ params: { id: "workspace" } }),
};
