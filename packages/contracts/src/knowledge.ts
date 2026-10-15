import type { BotId, RunId } from "./ids.js";

export interface KnowledgeDocument {
  id: string;
  title: string;
  body: string;
  version: number;
  sourceRunId?: RunId;
  approvedBy: string;
  updatedAt: string;
}
export interface KnowledgeProposal {
  id: string;
  title: string;
  body: string;
  sourceRunId?: RunId;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  documentId?: string;
  /**
   * A draft that updates an existing document (ADR-0011 amendment 4, A29): approval writes the
   * next version of this document, and only while it is still at `targetVersion`.
   */
  targetDocumentId?: string;
  targetVersion?: number;
  /** Notes a draft from observations cites, in citation order (A29). */
  citations?: KnowledgeCitation[];
}

/** One learned-memory note a Knowledge draft cites, at the version it was drafted from. */
export interface KnowledgeCitation {
  position: number;
  workspaceId: string;
  entryId: string;
  entryVersion: number;
  /** The note is no longer at that version, or is forgotten or superseded. */
  changed: boolean;
}
export interface KnowledgeHit {
  id: string;
  title: string;
  excerpt: string;
  version: number;
}

export interface KnowledgeVersion {
  documentId: string;
  version: number;
  path: string;
  title: string;
  body: string;
  sourceRunId?: RunId;
  approvedBy: string;
  createdAt: string;
}
export type MemorySuggestionStatus = "pending" | "applied" | "rejected";
export interface MemorySuggestion {
  id: string;
  runId: RunId;
  botId: BotId;
  body: string;
  status: MemorySuggestionStatus;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  appliedVersion?: string;
}
