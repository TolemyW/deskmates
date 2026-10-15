// ADR-0041: the search runs and operators receive. Unconfigured, every method is the FTS5 function
// it replaced, called with the same arguments (decision 1). Configured, a search fuses the bm25
// list with a brute-force vector list by reciprocal rank fusion and reranks the head (decision 5);
// a failed service call degrades to the stage before it and never fails the search (decision 7).

import type { KnowledgeHit, MemorySearchHit } from "@deskmates/contracts";
import type { RetrievalSettings } from "../config/retrieval.js";
import type { GatewayDb } from "../db/open.js";
import { type KnowledgeStore, ftsMatch } from "../knowledge/knowledge.js";
import {
  type MemorySearchOptions,
  memoryHitsByIds,
  memoryQueryTokens,
  searchMemoryPage,
} from "../memory/search.js";
import { chunkText, knowledgeChunkInput } from "./chunk.js";
import { EmbeddingClient, RerankClient, type RetrievalFetch } from "./clients.js";
import { applyRerank, reciprocalRankFusion, topByScore } from "./fuse.js";
import { type IndexerOptions, RetrievalIndexer } from "./indexer.js";
import { retrievalKnobs } from "./knobs.js";
import { type RetrievalCorpus, RetrievalUsage } from "./usage.js";
import { type ScoredSource, VectorStore } from "./vector-store.js";

/** At most this many sources are fused, so an operator page never ranks more (decision 5). */
export const FUSED_MAX = 100;
export const QUERY_TIMEOUT_MS = 5_000;
/** Rerank document text is cut here; bge-reranker reads 8192 tokens, a note is far shorter. */
const RERANK_TEXT_MAX = 4_000;

export interface RetrievalDeps {
  db: GatewayDb;
  knowledge: KnowledgeStore;
  settings?: RetrievalSettings | undefined;
  fetch?: RetrievalFetch;
  clock?: () => Date;
  log?: (msg: string, data: Record<string, unknown>) => void;
  indexer?: IndexerOptions;
  /** Query-time embedding and rerank timeout; tests shorten it. */
  queryTimeoutMs?: number;
}

export interface KnowledgeSearchOptions {
  limit?: number;
  /** The run whose tool asked, for usage attribution (decision 8). */
  runId?: string;
}

export type HybridMemoryOptions = MemorySearchOptions & { runId?: string };

interface Fused {
  ids: string[];
  /** Best chunk per source from the vector list. */
  chunks: Map<string, ScoredSource>;
}

export class HybridRetrieval {
  readonly settings: RetrievalSettings | undefined;
  readonly usage: RetrievalUsage;
  readonly vectors: VectorStore;
  /** Present only when an embedding service is configured. */
  readonly indexer: RetrievalIndexer | undefined;
  private readonly embedding: EmbeddingClient | undefined;
  private readonly reranker: RerankClient | undefined;

  constructor(private readonly deps: RetrievalDeps) {
    this.settings = deps.settings;
    this.usage = new RetrievalUsage(deps.db, deps.clock);
    this.vectors = new VectorStore(deps.db, deps.clock);
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    this.embedding = deps.settings?.embedding
      ? new EmbeddingClient(deps.settings.embedding, fetchImpl)
      : undefined;
    this.reranker = deps.settings?.rerank
      ? new RerankClient(deps.settings.rerank, fetchImpl)
      : undefined;
    this.indexer = this.embedding
      ? new RetrievalIndexer(this.vectors, this.embedding, this.usage, {
          ...(deps.log ? { log: deps.log } : {}),
          ...deps.indexer,
        })
      : undefined;
  }

  get enabled(): boolean {
    return this.settings !== undefined;
  }

  /** A document was published or changed: index it soon. A no-op when unconfigured. */
  kick(): void {
    this.indexer?.kick();
  }

  /** What `runs.config_json` records (decision 9); undefined when unconfigured. */
  knobs(): Record<string, unknown> | undefined {
    return this.settings ? retrievalKnobs(this.settings) : undefined;
  }

  // ---- Knowledge ------------------------------------------------------------------------------

  /** `knowledge_search` for a run: the top 5 by default, at most 20, as before. */
  async knowledgeSearch(
    tenantId: string,
    query: string,
    options: KnowledgeSearchOptions = {},
  ): Promise<KnowledgeHit[]> {
    const limit = options.limit ?? 5;
    if (!this.settings) return this.deps.knowledge.search(tenantId, query, limit);
    const fused = await this.fusedKnowledge(tenantId, query, options.runId);
    const take = fused.ids.slice(0, Math.max(1, Math.min(20, Math.floor(limit) || 5)));
    return this.knowledgeHits(tenantId, take);
  }

  /** The operator's Knowledge search page over the same order, with its length as the total. */
  async knowledgeSearchPage(
    tenantId: string,
    query: string,
    offset: number,
    limit: number,
  ): Promise<{ items: KnowledgeHit[]; total: number }> {
    if (!this.settings) return this.deps.knowledge.searchPage(tenantId, query, offset, limit);
    const fused = await this.fusedKnowledge(tenantId, query);
    return {
      items: this.knowledgeHits(tenantId, fused.ids.slice(offset, offset + limit)),
      total: fused.ids.length,
    };
  }

  private knowledgeHits(tenantId: string, ids: readonly string[]): KnowledgeHit[] {
    const hits = this.deps.knowledge.hitsByIds(tenantId, ids);
    return ids.flatMap((id) => {
      const hit = hits.get(id);
      return hit ? [hit] : [];
    });
  }

  private async fusedKnowledge(tenantId: string, query: string, runId?: string): Promise<Fused> {
    const settings = this.settings as RetrievalSettings;
    // Validation (length, no terms) and the lexical list are exactly the FTS5 path.
    if (!ftsMatch(query)) return { ids: [], chunks: new Map() };
    const lexical = this.deps.knowledge
      .searchPage(tenantId, query, 0, settings.candidates)
      .items.map((hit) => hit.id);
    const base = { tenantId, ...(runId ? { runId } : {}), corpus: "knowledge" as const };
    const queryVector = await this.embedQuery(base, query);
    const chunks = queryVector
      ? this.vectors.scanKnowledge(tenantId, this.embedding?.service.model ?? "", queryVector)
      : new Map<string, ScoredSource>();
    const dense = topByScore(
      new Map([...chunks].map(([id, scored]) => [id, scored.score])),
      settings.minSimilarity,
      settings.candidates,
    );
    const ids = reciprocalRankFusion([lexical, dense], settings.rrfK).slice(0, FUSED_MAX);
    const reranked = await this.rerank(base, query, ids, (head) => {
      const texts = this.deps.knowledge.textsByIds(tenantId, head);
      return head.map((id) => {
        const doc = texts.get(id);
        if (!doc) return "";
        const parts = chunkText(doc.body);
        const at = chunks.get(id)?.chunk ?? 0;
        return knowledgeChunkInput(doc.title, parts[at] ?? parts[0] ?? "");
      });
    });
    return { ids: reranked, chunks };
  }

  // ---- Learned memory -------------------------------------------------------------------------

  /** The operator's memory search page; `more` announces a further page (A15). */
  async memorySearchPage(
    options: HybridMemoryOptions,
  ): Promise<{ hits: MemorySearchHit[]; more: boolean }> {
    const { runId, ...search } = options;
    if (!this.settings) return searchMemoryPage(this.deps.db, search);
    const limit = Math.max(1, Math.min(50, Math.floor(search.limit ?? 10) || 10));
    const offset = Math.max(0, Math.floor(search.offset ?? 0));
    const fused = await this.fusedMemory(search, runId);
    return {
      hits: this.memoryHits(search, fused.slice(offset, offset + limit)),
      more: fused.length > offset + limit,
    };
  }

  /** `memory_search` for a run: the first page only, 10 by default, at most 20. */
  async memorySearch(options: HybridMemoryOptions): Promise<MemorySearchHit[]> {
    return (
      await this.memorySearchPage({
        ...options,
        limit: Math.min(20, options.limit ?? 10),
        offset: 0,
      })
    ).hits;
  }

  private memoryHits(options: MemorySearchOptions, ids: readonly string[]): MemorySearchHit[] {
    const hits = memoryHitsByIds(this.deps.db, options, ids);
    return ids.flatMap((id) => {
      const hit = hits.get(id);
      return hit ? [hit] : [];
    });
  }

  private async fusedMemory(options: MemorySearchOptions, runId?: string): Promise<string[]> {
    const settings = this.settings as RetrievalSettings;
    if (memoryQueryTokens(options.query).length === 0) return [];
    const now = options.now ?? new Date();
    const scoped = { ...options, now };
    const lexical = searchMemoryPage(this.deps.db, {
      ...scoped,
      limit: settings.candidates,
      offset: 0,
    }).hits.map((hit) => hit.id);
    const tenantId = this.tenantOfWorkspace(options.workspaceId);
    // An unknown workspace has nothing to fuse and no tenant to attribute a call to.
    if (!tenantId) return lexical.slice(0, FUSED_MAX);
    const base = { tenantId, ...(runId ? { runId } : {}), corpus: "memory" as const };
    const queryVector = await this.embedQuery(base, options.query);
    const chunks = queryVector
      ? this.vectors.scanMemory(scoped, this.embedding?.service.model ?? "", queryVector)
      : new Map<string, ScoredSource>();
    const dense = topByScore(
      new Map([...chunks].map(([id, scored]) => [id, scored.score])),
      settings.minSimilarity,
      settings.candidates,
    );
    const ids = reciprocalRankFusion([lexical, dense], settings.rrfK).slice(0, FUSED_MAX);
    return this.rerank(base, options.query, ids, (head) => {
      const hits = memoryHitsByIds(this.deps.db, scoped, head);
      return head.map((id) => hits.get(id)?.body ?? "");
    });
  }

  private tenantOfWorkspace(workspaceId: string): string | undefined {
    return (
      this.deps.db.prepare("SELECT tenant_id FROM workspaces WHERE id = ?").get(workspaceId) as
        | { tenant_id: string }
        | undefined
    )?.tenant_id;
  }

  // ---- Service calls --------------------------------------------------------------------------

  /** The query's vector, or undefined when vectors are off or the call failed (decision 7). */
  private async embedQuery(
    base: { tenantId: string; runId?: string; corpus: RetrievalCorpus },
    query: string,
  ): Promise<Float32Array | undefined> {
    const client = this.embedding;
    if (!client) return undefined;
    try {
      const answer = await this.usage.timed(
        { ...base, purpose: "query", service: "embedding", model: client.service.model, inputs: 1 },
        () => client.embed([query], this.deps.queryTimeoutMs ?? QUERY_TIMEOUT_MS),
        (result) => result.inputTokens,
      );
      return answer.vectors[0];
    } catch (error) {
      this.deps.log?.("retrieval query embedding failed; using bm25 only", {
        corpus: base.corpus,
        error: String(error),
      });
      return undefined;
    }
  }

  /** The fused order with its head reranked, or unchanged when off or failed (decision 7). */
  private async rerank(
    base: { tenantId: string; runId?: string; corpus: RetrievalCorpus },
    query: string,
    fused: string[],
    textsOf: (head: string[]) => string[],
  ): Promise<string[]> {
    const client = this.reranker;
    const settings = this.settings as RetrievalSettings;
    if (!client || fused.length < 2) return fused;
    const head = fused.slice(0, settings.rerankTopN);
    const documents = textsOf(head).map((text) => text.slice(0, RERANK_TEXT_MAX));
    try {
      const answer = await this.usage.timed(
        {
          ...base,
          purpose: "query",
          service: "rerank",
          model: client.service.model,
          inputs: documents.length,
        },
        () => client.rerank(query, documents, this.deps.queryTimeoutMs ?? QUERY_TIMEOUT_MS),
        (result) => result.inputTokens,
      );
      return applyRerank(fused, answer.scores);
    } catch (error) {
      this.deps.log?.("retrieval rerank failed; using the fused order", {
        corpus: base.corpus,
        error: String(error),
      });
      return fused;
    }
  }
}
