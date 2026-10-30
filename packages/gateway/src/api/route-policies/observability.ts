// Operator route policies for observability (ADR-0046 decision 8); aggregated in
// `../route-policy.ts` (ADR-0022 P2). The pipeline spans every workspace, so it is the root's.

import { type PolicyTable, root } from "./policy.js";

export const observabilityRoutePolicies: PolicyTable = {
  "GET /api/observability/status": root(),
};
