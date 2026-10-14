// Operator route policies for memory; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, member } from "./policy.js";

export const memoryRoutePolicies: PolicyTable = {
  "GET /api/memory-suggestions": member({
    query: { workspaceId: "workspace", botId: "bot" },
    scopedList: true,
  }),
  "POST /api/memory-suggestions/:id/review": admin({
    params: { id: "memorySuggestion" },
  }),
  "GET /api/workspaces/:id/memory": member({
    params: { id: "workspace" },
    query: { botId: "bot" },
  }),
  "GET /api/workspaces/:id/memory/search": member({ params: { id: "workspace" } }),
  "GET /api/workspaces/:id/memory/topics": member({
    params: { id: "workspace" },
    query: { botId: "bot" },
  }),
  "GET /api/workspaces/:id/memory-review/groups": member({ params: { id: "workspace" } }),
  // Batch dispositions decide gated items, like a single review (ADR-0011 amendment 3, A18).
  "POST /api/workspaces/:id/memory-review/preview": admin({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/memory-review/batches": admin({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/memory-review/undo": admin({
    params: { id: "workspace" },
  }),
  "GET /api/memory/entries/:id/versions": member({ params: { id: "memoryEntry" } }),
  "GET /api/memory/entries/:id/provenance": member({ params: { id: "memoryEntry" } }),
  "GET /api/memory/versions": member({ scopedList: true }),
  "GET /api/runs/:id/memory-versions": member({ params: { id: "run" } }),
  // Memory curation is configuration (ADR-0022 amendment 1, C2): Admins curate, Members read.
  "PATCH /api/memory/entries/:id": admin({ params: { id: "memoryEntry" } }),
  "POST /api/memory/entries/:id/forget": admin({
    params: { id: "memoryEntry" },
  }),
  "POST /api/memory/entries/:id/undo": admin({
    params: { id: "memoryEntry" },
  }),
  "POST /api/memory/entries/:id/confirm": admin({
    params: { id: "memoryEntry" },
  }),
};
