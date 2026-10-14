import type { KnowledgeDocument } from "@deskmates/contracts";
import type { ApiClient, MemoryView } from "../../api/client.js";

export interface KnowledgeDraft {
  title: string;
  body: string;
  dirty: boolean;
  loaded?: KnowledgeDocument;
  latest?: KnowledgeDocument;
}

export interface MemoryDraft {
  body: string;
  dirty: boolean;
  loaded: MemoryView;
  latest?: MemoryView;
}

export interface OperatorDrafts {
  knowledge: Map<string, KnowledgeDraft>;
  memory: Map<string, MemoryDraft>;
  knowledgeSelection?: string;
  memorySelection?: string;
}

const draftsByClient = new WeakMap<ApiClient, OperatorDrafts>();

/**
 * Drafts live exactly as long as their authenticated API client. Route changes keep the client,
 * while disconnecting or reloading creates a new one and drops every draft without persistent
 * browser storage.
 */
export function operatorDrafts(api: ApiClient): OperatorDrafts {
  const existing = draftsByClient.get(api);
  if (existing) return existing;
  const created: OperatorDrafts = { knowledge: new Map(), memory: new Map() };
  draftsByClient.set(api, created);
  return created;
}
