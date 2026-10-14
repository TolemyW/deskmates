// Operator route policies for the workspace message board; aggregated in `../route-policy.ts`
// (ADR-0022 amendment 6 W10). Every current member of the workspace, Guests included, reads and
// posts; posts are looked up inside the guarded workspace, so another workspace's post is 404.

import { type PolicyTable, admin, guest } from "./policy.js";

const PERSON =
  "people only (a service principal is refused); the post is looked up in the workspace";

export const boardRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/board": guest({
    params: { id: "workspace" },
    handlerCheck: "hidden posts reach moderators (Admin or Owner) only",
  }),
  "POST /api/workspaces/:id/board": guest({ params: { id: "workspace" }, handlerCheck: PERSON }),
  "PATCH /api/workspaces/:id/board/:postId": guest({
    params: { id: "workspace" },
    handlerCheck: `only the author edits; ${PERSON}`,
  }),
  "POST /api/workspaces/:id/board/:postId/withdraw": guest({
    params: { id: "workspace" },
    handlerCheck: `only the author withdraws; ${PERSON}`,
  }),
  "POST /api/workspaces/:id/board/:postId/moderate": admin({
    params: { id: "workspace" },
    handlerCheck: PERSON,
  }),
  "GET /api/workspaces/:id/board/:postId/history": guest({
    params: { id: "workspace" },
    handlerCheck: `the author or a moderator only; ${PERSON}`,
  }),
};
