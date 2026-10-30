// Operator route policies for the bot's own `run_stats` switch (ADR-0050 decision 6); aggregated
// in `../route-policy.ts`.

import { type PolicyTable, admin, member } from "./policy.js";

export const runStatsRoutePolicies: PolicyTable = {
  "GET /api/bots/:id/run-stats": member({ params: { id: "bot" } }),
  "PUT /api/bots/:id/run-stats": admin({ params: { id: "bot" } }),
};
