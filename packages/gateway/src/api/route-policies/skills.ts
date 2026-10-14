// Operator route policies for skills; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, member } from "./policy.js";

export const skillsRoutePolicies: PolicyTable = {
  // Skills (ADR-0015): members read; installing, reviewing and spreading a skill is an Admin's
  // change to what every assigned bot is told, like published Knowledge.
  "GET /api/workspaces/:id/skills": member({ params: { id: "workspace" } }),
  "GET /api/workspaces/:id/skills/pending": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/skills": admin({
    params: { id: "workspace" },
    body: { botIds: "bot[]" },
  }),
  "GET /api/skills/:id/versions": member({ params: { id: "skill" } }),
  "GET /api/skills/versions": member({ scopedList: true }),
  "POST /api/skills/:id/versions/:version/confirm": admin({
    params: { id: "skill" },
    handlerCheck: "the version number is looked up within the guarded skill",
  }),
  "POST /api/skills/:id/versions/:version/reject": admin({
    params: { id: "skill" },
    handlerCheck: "the version number is looked up within the guarded skill",
  }),
  "POST /api/skills/:id/assign": admin({ params: { id: "skill" }, body: { botIds: "bot[]" } }),
  "POST /api/skills/:id/promote": admin({
    params: { id: "skill" },
    handlerCheck: "evidence bots must belong to the skill's workspace",
  }),
  "PATCH /api/skills/:id": admin({ params: { id: "skill" } }),
  "POST /api/skills/:id/undo": admin({ params: { id: "skill" } }),
};
