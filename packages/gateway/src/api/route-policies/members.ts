// Operator route policies for members; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, root } from "./policy.js";

/** ADR-0022 amendment 1 A13: people routes refuse every service principal, whatever its role. */
const PEOPLE_ONLY = "people only: a service principal of any role is refused (people_only)";

export const membersRoutePolicies: PolicyTable = {
  // Membership and invitations (P4): user ids and invitation ids are looked up inside the
  // request's tenant by the handler, so another tenant's id is the same 404 as a missing one.
  "GET /api/members": admin({ scopedList: true, handlerCheck: PEOPLE_ONLY }),
  // Roles are per workspace (ADR-0031 decision 7): a role change, an invitation and a created
  // account name one workspace (or the tenant's only one), and the handler checks the actor's
  // role there.
  "PATCH /api/members/:userId": admin({
    handlerCheck: `membership looked up in the tenant; a role change needs the actor's role in its workspace; ${PEOPLE_ONLY}`,
  }),
  "GET /api/invitations": admin({ scopedList: true, handlerCheck: PEOPLE_ONLY }),
  "POST /api/invitations": admin({
    handlerCheck: `Admin or Owner of the invitation's workspace; ${PEOPLE_ONLY}`,
  }),
  "DELETE /api/invitations/:id": admin({
    handlerCheck: `invitation looked up in the tenant; ${PEOPLE_ONLY}`,
  }),
  // An Admin creates a local account in the tenant (ADR-0022 amendment 4); the handler limits an
  // Admin to Members and refuses Owners, like invitations.
  "POST /api/accounts": admin({
    handlerCheck: `Admin or Owner of the account's workspace; ${PEOPLE_ONLY}`,
  }),
  // Service principals (ADR-0022 amendment 2): a tenant's machine identities, managed by Admins.
  // ADR-0031 Q2, ADR-0022 amendment 6 W2: the root's alone; the store looks every id up in the
  // request's tenant, so another tenant's principal is the uniform 404.
  "GET /api/service-principals": root("listed for the request's tenant only"),
  "POST /api/service-principals": root(),
  "POST /api/service-principals/:id/disable": root("principal looked up in the tenant"),
  "POST /api/service-principals/:id/rotate": root("principal looked up in the tenant"),
};
