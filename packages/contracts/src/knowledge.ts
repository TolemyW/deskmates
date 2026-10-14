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
