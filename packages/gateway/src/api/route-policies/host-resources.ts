// Operator route policies for host resources; aggregated in `../route-policy.ts` (ADR-0022 P2).
// ADR-0006 amendment 5 decisions 12 and 13: the host's containers, networks and volumes are
// installation-level facts, read and repaired by the root alone.

import { type PolicyTable, root } from "./policy.js";

export const hostResourcesRoutePolicies: PolicyTable = {
  "GET /api/runtime/resources": root(),
  "POST /api/runtime/resources/reattach": root(
    "the finding is still present, offers Re-attach and no run is live in its workspace",
  ),
  "POST /api/runtime/resources/remove": root(
    "the finding is still present, offers Remove and no run is live in its workspace",
  ),
};
