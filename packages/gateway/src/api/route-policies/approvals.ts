// Operator route policies for approvals; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, member } from "./policy.js";

export const approvalsRoutePolicies: PolicyTable = {
  "GET /api/approval-groups": member({
    query: { botId: "bot" },
    scopedList: true,
    handlerCheck:
      "groups only the approvals visible in the caller's inbox; another person's private chat is absent",
  }),
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
  "POST /api/approval-groups/:key/decide": member({
    handlerCheck:
      "each visible pending approval is independently decided and audited; below Admin only own runs, and allow_all remains one-time",
  }),
  "GET /api/bots/:id/approval-rules": member({ params: { id: "bot" } }),
  "POST /api/bots/:id/approval-rules": admin({ params: { id: "bot" } }),
  "PATCH /api/approval-rules/:id": admin({ params: { id: "approvalRule" } }),
  "DELETE /api/approval-rules/:id": admin({ params: { id: "approvalRule" } }),
  // ADR-0002 amendment 6, D1: an Owner or Admin changes the approval mode; members read it.
  "GET /api/workspaces/:id/auto-approval": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/auto-approval": admin({ params: { id: "workspace" } }),
  // ADR-0002 amendment 3, A5: an Owner or Admin overrides a tool's tier; members read the list.
  "GET /api/workspaces/:id/tool-tiers": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/tool-tiers/:toolName": admin({
    params: { id: "workspace" },
    handlerCheck:
      "toolName is a tool name, not a row id: the override is keyed by the guarded workspace",
  }),
  "DELETE /api/workspaces/:id/tool-tiers/:toolName": admin({
    params: { id: "workspace" },
    handlerCheck:
      "toolName is a tool name, not a row id: the override is keyed by the guarded workspace",
  }),
};
