// Operator route policies for network profiles; aggregated in `../route-policy.ts` (ADR-0022 P2).
// ADR-0027 amendment 1 decision 12 (proposed): a profile reaches into the deployment's private
// networks, so defining and selecting one is the root's alone; Owners and Admins read.

import { type PolicyTable, admin, root } from "./policy.js";

export const networkRoutePolicies: PolicyTable = {
  // Amendment 2 decision 15: installation-level network facts, like the profiles.
  "GET /api/network-overlaps": root(),
  "GET /api/network-profiles": root(),
  "POST /api/network-profiles": root(),
  "PUT /api/network-profiles/:id": root("profile looked up by id; installation-level"),
  "DELETE /api/network-profiles/:id": root("profile looked up by id; installation-level"),
  "GET /api/workspaces/:id/network": admin({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/network-profiles": root("workspace looked up by id"),
  // Decision 14: a read-only diagnostic for the workspace's own Owners and Admins.
  "POST /api/workspaces/:id/network-preflight": admin({ params: { id: "workspace" } }),
};
