// Operator route policies for network profiles; aggregated in `../route-policy.ts` (ADR-0022 P2).
// ADR-0027 amendment 1 decision 12 (owner-decided 2026-10-14): the root and workspace Owners
// define profiles; a workspace's Admins and Owners select among those available there.

import { type PolicyTable, admin, root } from "./policy.js";

/** A person who is Owner of at least one workspace; the handler applies root-or-creator. */
const owner = (handlerCheck: string) =>
  ({ access: "tenant", role: "owner", handlerCheck }) as const;

const CREATOR = "the root, or the Owner who created the profile; anyone else 403 profile_owner";

export const networkRoutePolicies: PolicyTable = {
  // Amendment 2 decision 15: installation-level network facts.
  "GET /api/network-overlaps": root(),
  "GET /api/network-profiles": owner(
    "the root sees every profile; an Owner the root's, their own and their co-Owners'",
  ),
  "POST /api/network-profiles": owner("an Owner's profile names its creator"),
  "PUT /api/network-profiles/:id": owner(CREATOR),
  "DELETE /api/network-profiles/:id": owner(CREATOR),
  "GET /api/workspaces/:id/network": admin({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/network-profiles": admin({
    params: { id: "workspace" },
    handlerCheck:
      "only profiles available in the workspace, or already selected there; the root any",
  }),
  // Decision 13: the open-internet switch.
  "PUT /api/workspaces/:id/network-settings": admin({ params: { id: "workspace" } }),
  // Decision 14: a read-only diagnostic for the workspace's own Owners and Admins.
  "POST /api/workspaces/:id/network-preflight": admin({ params: { id: "workspace" } }),
};
