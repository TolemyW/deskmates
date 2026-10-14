// Knowledge base and governance, bot MEMORY.md, and learned memory with its confirmations
// (ADR-0011): everything the Knowledge, Observations and Learned memory screens read or change.

import type {
  BotId,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeProposal,
  KnowledgeVersion,
  MemoryBatchDecision,
  MemoryBatchPreview,
  MemoryConfirmation,
  MemoryEntry,
  MemoryEntrySource,
  MemoryReviewBatch,
  MemoryReviewGroup,
  MemorySuggestionStatus,
  MemorySupersession,
  MemoryVersion,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import type { MemoryView, RunView } from "../../api/types.js";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

/** A learned memory entry as the operator list returns it: `live` is false once closed or expired. */
export interface LearnedMemoryEntry extends MemoryEntry {
  live: boolean;
  episodeId?: string;
}

/** One page of the pending queue as review groups (ADR-0011 amendment 3, A17). */
export interface MemoryReviewGroupsPage {
  groups: MemoryReviewGroup[];
  nextCursor?: string;
  totalGroups: number;
  totalItems: number;
  /** The latest batch dispositions of the workspace, newest first, for undo (A19). */
  batches: MemoryReviewBatch[];
}

/** A topic tag and how many entries carry it (A20). */
export interface MemoryTopicCount {
  key: string;
  label: string;
  count: number;
}

/** Sources and supersession receipts of one learned memory entry (ADR-0011 amendment 2). */
export interface MemoryProvenance {
  sources: MemoryEntrySource[];
  supersessions: MemorySupersession[];
}

export interface KnowledgeApi {
  cleanupKnowledgeVersions(): Promise<{ removed: number; retained: number }>;
  closeThreadTask(id: ThreadId): Promise<{ episode: MemoryEntry | null; distilled: string[] }>;
  confirmMemoryEntry(entryId: string): Promise<MemoryEntry>;
  consolidateBotMemory(id: BotId): Promise<{ run: RunView }>;
  editKnowledge(
    id: string,
    title: string,
    body: string,
    version: number,
  ): Promise<KnowledgeDocument>;
  editMemoryEntry(entryId: string, body: string, expectedVersion?: number): Promise<MemoryEntry>;
  forgetMemoryEntry(entryId: string): Promise<MemoryEntry>;
  getKnowledge(id: string): Promise<KnowledgeDocument>;
  listKnowledgeHistory(
    id: string,
    filters?: { cursor?: string; limit?: number },
  ): Promise<{ versions: KnowledgeVersion[]; nextCursor?: string }>;
  /**
   * One page of published documents (#113): by cursor, newest first, or with `q` one page of
   * matches by offset over the rank. `total` is the whole list's (or all matches') size.
   */
  listKnowledgePage(filters?: {
    q?: string;
    cursor?: string;
    offset?: number;
    limit?: number;
  }): Promise<{ documents: KnowledgeHit[]; nextCursor?: string; total?: number }>;
  /** One page of proposals with this status; `total` counts the whole queue (#113). */
  listKnowledgeProposalsPage(filters?: {
    status?: KnowledgeProposal["status"];
    cursor?: string;
    limit?: number;
  }): Promise<{ proposals: KnowledgeProposal[]; nextCursor?: string; total?: number }>;
  /** Batch dispositions of one review group (A18, A19): preview, commit with its token, undo. */
  commitMemoryBatch(
    workspaceId: WorkspaceId,
    input: { groupKey: string; decision: MemoryBatchDecision; token: string },
  ): Promise<MemoryReviewBatch>;
  /**
   * One page of learned memory of one workspace (ADR-0011, #113 surface 18), newest first;
   * `botId`, `scope`, `threadId` and `topic` filter on the server.
   */
  listMemoryEntriesPage(
    workspaceId: WorkspaceId,
    filters?: {
      botId?: BotId;
      scope?: "task" | "workspace" | "bot";
      threadId?: ThreadId;
      topic?: string;
      includeForgotten?: boolean;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ entries: LearnedMemoryEntry[]; nextCursor?: string }>;
  listMemoryReviewGroups(
    workspaceId: WorkspaceId,
    filters?: { cursor?: string; limit?: number },
  ): Promise<MemoryReviewGroupsPage>;
  /** "Needs your confirmation" (ADR-0011): gated learned items only. */
  listMemorySuggestions(filters?: {
    workspaceId?: WorkspaceId;
    botId?: BotId;
    status?: MemorySuggestionStatus;
    cursor?: string;
    limit?: number;
  }): Promise<{ suggestions: MemoryConfirmation[]; nextCursor?: string; total?: number }>;
  /** Topic tags with counts (A20); `total` is the number of topics. */
  listMemoryTopics(
    workspaceId: WorkspaceId,
    filters?: { offset?: number; limit?: number },
  ): Promise<{ topics: MemoryTopicCount[]; total: number }>;
  /** One page of an entry's versions, newest first; "Load older" follows `nextCursor`. */
  listMemoryVersionsPage(
    entryId: string,
    filters?: { cursor?: string },
  ): Promise<{ versions: MemoryVersion[]; nextCursor?: string }>;
  previewMemoryBatch(
    workspaceId: WorkspaceId,
    input: { groupKey: string; decision: MemoryBatchDecision },
  ): Promise<MemoryBatchPreview>;
  proposeKnowledge(title: string, body: string): Promise<KnowledgeProposal>;
  readMemory(id: BotId): Promise<MemoryView>;
  reviewKnowledge(id: string, decision: "approve" | "reject"): Promise<KnowledgeProposal>;
  reviewMemorySuggestion(
    id: string,
    input: { decision: "apply" | "reject"; authorId?: string },
  ): Promise<{ suggestion: MemoryConfirmation; entry?: MemoryEntry }>;
  /** Where an entry came from and what it replaced or was replaced by (ADR-0011 A10, A12). */
  memoryProvenance(entryId: string): Promise<MemoryProvenance>;
  /** First page of search only (20 matches); screens use `searchLearnedMemoryPage`. */
  searchLearnedMemory(
    workspaceId: WorkspaceId,
    q: string,
    scope?: "task" | "workspace" | "bot",
  ): Promise<LearnedMemoryEntry[]>;
  /** A page of search with the cursor of the next one, so no match is dropped (A15). */
  searchLearnedMemoryPage(
    workspaceId: WorkspaceId,
    q: string,
    filters?: { scope?: "task" | "workspace" | "bot"; cursor?: string },
  ): Promise<{ entries: LearnedMemoryEntry[]; nextCursor?: string }>;
  undoMemoryBatch(workspaceId: WorkspaceId, batchId: string): Promise<MemoryReviewBatch>;
  undoMemoryEntry(entryId: string): Promise<MemoryEntry>;
  writeMemory(id: BotId, body: string, expectedVersion: string): Promise<MemoryView>;
}

export function createKnowledgeApi(t: HttpTransport): KnowledgeApi {
  const entry = (entryId: string) => `/api/memory/entries/${encodeURIComponent(entryId)}`;
  const review = (workspaceId: WorkspaceId, path: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/memory-review/${path}`;
  return {
    async commitMemoryBatch(workspaceId, input) {
      return (
        await t.json<{ batch: MemoryReviewBatch }>("POST", review(workspaceId, "batches"), input)
      ).batch;
    },
    cleanupKnowledgeVersions() {
      return t.json("POST", "/api/knowledge/versions/cleanup");
    },
    closeThreadTask(id) {
      return t.json("POST", `/api/threads/${encodeURIComponent(id)}/close-task`, {});
    },
    async confirmMemoryEntry(entryId) {
      return (await t.json<{ entry: MemoryEntry }>("POST", `${entry(entryId)}/confirm`, {})).entry;
    },
    consolidateBotMemory(id) {
      return t.json("POST", `/api/bots/${encodeURIComponent(id)}/memory/consolidate`, {});
    },
    async editKnowledge(id, title, body, version) {
      return (
        await t.json<{ document: KnowledgeDocument }>(
          "PATCH",
          `/api/knowledge/${encodeURIComponent(id)}`,
          { title, body, version },
        )
      ).document;
    },
    async editMemoryEntry(entryId, body, expectedVersion) {
      return (
        await t.json<{ entry: MemoryEntry }>(
          "PATCH",
          entry(entryId),
          stripUndefined({ body, expectedVersion }),
        )
      ).entry;
    },
    async forgetMemoryEntry(entryId) {
      return (await t.json<{ entry: MemoryEntry }>("POST", `${entry(entryId)}/forget`, {})).entry;
    },
    async getKnowledge(id) {
      return (
        await t.json<{ document: KnowledgeDocument }>(
          "GET",
          `/api/knowledge/${encodeURIComponent(id)}`,
        )
      ).document;
    },
    listKnowledgeHistory(id, filters = {}) {
      return t.json(
        "GET",
        `/api/knowledge/${encodeURIComponent(id)}/history${query({ ...filters })}`,
      );
    },
    listKnowledgePage(filters = {}) {
      return t.json("GET", `/api/knowledge${query({ ...filters })}`);
    },
    listKnowledgeProposalsPage(filters = {}) {
      return t.json("GET", `/api/knowledge/proposals${query({ ...filters })}`);
    },
    listMemoryEntriesPage(workspaceId, filters = {}) {
      const { includeForgotten, ...rest } = filters;
      return t.json(
        "GET",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/memory${query({
          ...rest,
          includeForgotten: includeForgotten ? "1" : undefined,
        })}`,
      );
    },
    listMemoryReviewGroups(workspaceId, filters = {}) {
      return t.json("GET", `${review(workspaceId, "groups")}${query({ ...filters })}`);
    },
    listMemorySuggestions(filters = {}) {
      return t.json("GET", `/api/memory-suggestions${query({ ...filters })}`);
    },
    listMemoryTopics(workspaceId, filters = {}) {
      return t.json(
        "GET",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/topics${query({ ...filters })}`,
      );
    },
    listMemoryVersionsPage(entryId, filters = {}) {
      return t.json("GET", `${entry(entryId)}/versions${query({ ...filters })}`);
    },
    async previewMemoryBatch(workspaceId, input) {
      return (
        await t.json<{ preview: MemoryBatchPreview }>("POST", review(workspaceId, "preview"), input)
      ).preview;
    },
    async proposeKnowledge(title, body) {
      return (
        await t.json<{ proposal: KnowledgeProposal }>("POST", "/api/knowledge/proposals", {
          title,
          body,
        })
      ).proposal;
    },
    async readMemory(id) {
      return (
        await t.json<{ memory: MemoryView }>("GET", `/api/bots/${encodeURIComponent(id)}/memory`)
      ).memory;
    },
    async reviewKnowledge(id, decision) {
      return (
        await t.json<{ proposal: KnowledgeProposal }>(
          "POST",
          `/api/knowledge/proposals/${encodeURIComponent(id)}/review`,
          { decision },
        )
      ).proposal;
    },
    reviewMemorySuggestion(id, input) {
      return t.json("POST", `/api/memory-suggestions/${encodeURIComponent(id)}/review`, input);
    },
    memoryProvenance(entryId) {
      return t.json("GET", `${entry(entryId)}/provenance`);
    },
    searchLearnedMemoryPage(workspaceId, q, filters = {}) {
      return t.json(
        "GET",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/search${query({ q, ...filters })}`,
      );
    },
    async searchLearnedMemory(workspaceId, q, scope) {
      return (
        await t.json<{ entries: LearnedMemoryEntry[] }>(
          "GET",
          `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/search${query({ q, scope })}`,
        )
      ).entries;
    },
    async undoMemoryBatch(workspaceId, batchId) {
      return (
        await t.json<{ batch: MemoryReviewBatch }>("POST", review(workspaceId, "undo"), {
          batchId,
        })
      ).batch;
    },
    async undoMemoryEntry(entryId) {
      return (await t.json<{ entry: MemoryEntry }>("POST", `${entry(entryId)}/undo`, {})).entry;
    },
    async writeMemory(id, body, expectedVersion) {
      return (
        await t.json<{ memory: MemoryView }>(
          "PATCH",
          `/api/bots/${encodeURIComponent(id)}/memory`,
          {
            body,
            expectedVersion,
          },
        )
      ).memory;
    },
  };
}
