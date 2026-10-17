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
  // ADR-0011 amendment 4: reading the maintenance queues is a Member's; deciding is curation.
  "GET /api/workspaces/:id/memory/revalidations": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/memory/revalidations/:itemId": admin({
    params: { id: "workspace" },
    handlerCheck: "the revalidation must belong to the workspace in the path",
  }),
  // A29: a draft makes the selected wording visible to the tenant's proposal reviewers.
  "POST /api/workspaces/:id/memory/document-drafts": admin({
    params: { id: "workspace" },
    body: { entryIds: "memoryEntry[]", targetDocumentId: "knowledgeDoc" },
  }),
  // A28, A34 (owner ruling 2026-10-14): the latest recheck job and the settings are a Member's to
  // read; changing the settings is an Owner's or Admin's.
  "GET /api/workspaces/:id/memory/maintenance": member({ params: { id: "workspace" } }),
  "PUT /api/workspaces/:id/memory/maintenance": admin({ params: { id: "workspace" } }),
  "GET /api/workspaces/:id/memory/organize": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/memory/organize": admin({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/memory/organize/reset-labels": admin({ params: { id: "workspace" } }),
  "GET /api/workspaces/:id/memory/splits": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/memory/splits/:itemId": admin({
    params: { id: "workspace" },
    handlerCheck: "the split proposal must belong to the workspace in the path",
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
