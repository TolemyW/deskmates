// Operator route policies for runs; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, guest, member } from "./policy.js";

export const runsRoutePolicies: PolicyTable = {
  "GET /api/runs": member({
    query: { threadId: "thread", botId: "bot", workspaceId: "workspace" },
    scopedList: true,
    handlerCheck: "listed only from the caller's workspaces, without other people's private chats",
  }),
  // ADR-0042: what a run changed, and the Owner's or Admin's mark that makes it do-not-learn.
  "GET /api/runs/:id/changes": member({ params: { id: "run" } }),
  "PUT /api/runs/:id/mark": admin({ params: { id: "run" } }),
  "DELETE /api/runs/:id/mark": admin({ params: { id: "run" } }),
  "GET /api/runs/latest-by-bot": member({
    query: { workspaceId: "workspace" },
    scopedList: true,
    handlerCheck: "one workspace's runs, without other people's private chats",
  }),
  "GET /api/runs/memory-index": member({
    query: { workspaceId: "workspace" },
    scopedList: true,
    handlerCheck: "one workspace's runs, without other people's private chats",
  }),
  "GET /api/runs/:id": member({ params: { id: "run" } }),
  "GET /api/runs/:id/events": member({ params: { id: "run" } }),
  "POST /api/runs/:id/cancel": member({
    params: { id: "run" },
    handlerCheck:
      "below Admin (Member or member principal) cancels only the runs it started (run_not_started_by_you)",
  }),
  "GET /api/runs/:id/context": member({ params: { id: "run" } }),
  "GET /api/runs/:id/timeline": member({ params: { id: "run" } }),
  "POST /api/runs/:id/continuation/decide": member({
    params: { id: "run" },
    handlerCheck:
      "below Admin (Member or member principal) answers a continuation ask only for the runs it started",
  }),
  "GET /api/events": guest({
    query: { threadId: "thread" },
    scopedList: true,
    handlerCheck:
      "an event reaches a stream only when its subscriber may read it: workspace role, private audience; a Guest gets conversation, board and workspace events only",
  }),
};
