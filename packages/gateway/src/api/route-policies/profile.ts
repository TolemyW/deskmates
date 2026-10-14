// Operator route policies for profile; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, authenticated } from "./policy.js";

export const profileRoutePolicies: PolicyTable = {
  // The person's own UI preferences (issue #22); the handler refuses a principal with no user.
  "PATCH /auth/preferences": authenticated,
  // The person's own profile and avatar (ADR-0022 amendment 3); no route names a user, and the
  // handlers refuse a principal with no user.
  "PATCH /auth/profile": authenticated,
  "PUT /auth/avatar": authenticated,
  "DELETE /auth/avatar": authenticated,
  "GET /auth/avatar": authenticated,
};
