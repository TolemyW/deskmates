// ADR-0041 decision 3: chunk vectors in SQLite beside the rows they describe. Every read carries
// the source's scope (tenant for Knowledge, workspace plus the search liveness filter for memory)
// in the same SQL, so a vector can never surface a row its search would not.

import type { GatewayDb } from "../db/open.js";
import type { MemorySearchOptions } from "../memory/search.js";
import { memoryLiveFilter } from "../memory/search.js";
import { dot, fromBlob, toBlob } from "./vectors.js";

export interface PendingKnowledge {
  id: string;
  tenantId: string;
  title: string;
  body: string;
}

export interface PendingMemory {
  id: string;
  workspaceId: string;
  tenantId: string;
  body: string;
}

/** A source's best chunk score against a query. */
export interface ScoredSource {
  score: number;
  chunk: number;
}

function best(rows: Iterable<{ id: string; chunk: number; vector: Buffer }>, query: Float32Array) {
  const out = new Map<string, ScoredSource>();
  for (const row of rows) {
    const score = dot(fromBlob(row.vector), query);
    const seen = out.get(row.id);
    if (!seen || score > seen.score) out.set(row.id, { score, chunk: row.chunk });
  }
  return out;
}

export class VectorStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Vectors of any other model are never read again (decision 3). */
  dropOtherModels(model: string): number {
    return (
      this.db.prepare("DELETE FROM knowledge_chunk_vectors WHERE model <> ?").run(model).changes +
      this.db.prepare("DELETE FROM memory_chunk_vectors WHERE model <> ?").run(model).changes
    );
  }

  /** Published documents with no vector for `model`, grouped by tenant. */
  pendingKnowledge(model: string, limit: number, skip: ReadonlySet<string>): PendingKnowledge[] {
    return this.db
      .prepare(
        `SELECT d.id, d.tenant_id AS tenantId, d.title, d.body FROM knowledge_docs d
          WHERE d.approved_by IS NOT NULL AND trim(d.title || d.body) <> ''
            AND d.id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM knowledge_chunk_vectors v
                             WHERE v.document_id = d.id AND v.model = ?)
          ORDER BY d.tenant_id, d.rowid LIMIT ?`,
      )
      .all(JSON.stringify([...skip]), model, limit) as PendingKnowledge[];
  }

  /** Searchable entries (not forgotten, not distilled) with no vector for `model`. */
  pendingMemory(model: string, limit: number, skip: ReadonlySet<string>): PendingMemory[] {
    return this.db
      .prepare(
        `SELECT e.id, e.workspace_id AS workspaceId, w.tenant_id AS tenantId, e.body
           FROM memory_entries e JOIN workspaces w ON w.id = e.workspace_id
          WHERE e.tombstoned = 0 AND e.episode_id IS NULL AND trim(e.body) <> ''
            AND e.id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM memory_chunk_vectors v
                             WHERE v.entry_id = e.id AND v.model = ?)
          ORDER BY e.workspace_id, e.rowid LIMIT ?`,
      )
      .all(JSON.stringify([...skip]), model, limit) as PendingMemory[];
  }

  /**
   * Replace a document's vectors for `model`, only if it still has the title and body that were
   * embedded. Returns whether it wrote.
   */
  writeKnowledge(
    source: PendingKnowledge,
    model: string,
    vectors: readonly Float32Array[],
  ): boolean {
    return this.db.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT title, body FROM knowledge_docs WHERE id = ? AND tenant_id = ? AND approved_by IS NOT NULL",
        )
        .get(source.id, source.tenantId) as { title: string; body: string } | undefined;
      if (!current || current.title !== source.title || current.body !== source.body) return false;
      this.db
        .prepare("DELETE FROM knowledge_chunk_vectors WHERE document_id = ? AND model = ?")
        .run(source.id, model);
      const insert = this.db.prepare(
        `INSERT INTO knowledge_chunk_vectors
           (document_id, model, chunk, tenant_id, dimensions, vector, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = this.clock().toISOString();
      vectors.forEach((vector, chunk) =>
        insert.run(source.id, model, chunk, source.tenantId, vector.length, toBlob(vector), now),
      );
      return true;
    })();
  }

  /** Replace an entry's vectors, only if it is still searchable with the embedded body. */
  writeMemory(source: PendingMemory, model: string, vectors: readonly Float32Array[]): boolean {
    return this.db.transaction(() => {
      const current = this.db
        .prepare(
          `SELECT body FROM memory_entries
            WHERE id = ? AND workspace_id = ? AND tombstoned = 0 AND episode_id IS NULL`,
        )
        .get(source.id, source.workspaceId) as { body: string } | undefined;
      if (!current || current.body !== source.body) return false;
      this.db
        .prepare("DELETE FROM memory_chunk_vectors WHERE entry_id = ? AND model = ?")
        .run(source.id, model);
      const insert = this.db.prepare(
        `INSERT INTO memory_chunk_vectors
           (entry_id, model, chunk, workspace_id, dimensions, vector, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = this.clock().toISOString();
      vectors.forEach((vector, chunk) =>
        insert.run(source.id, model, chunk, source.workspaceId, vector.length, toBlob(vector), now),
      );
      return true;
    })();
  }

  /** Every published document of one tenant scored by its best chunk (brute force). */
  scanKnowledge(tenantId: string, model: string, query: Float32Array): Map<string, ScoredSource> {
    return best(
      this.db
        .prepare(
          `SELECT v.document_id AS id, v.chunk, v.vector FROM knowledge_chunk_vectors v
             JOIN knowledge_docs d ON d.id = v.document_id
            WHERE v.tenant_id = ? AND v.model = ? AND d.tenant_id = ?
              AND d.approved_by IS NOT NULL`,
        )
        .iterate(tenantId, model, tenantId) as Iterable<{
        id: string;
        chunk: number;
        vector: Buffer;
      }>,
      query,
    );
  }

  /** Every live entry of one workspace (search's own filter) scored by its best chunk. */
  scanMemory(
    options: Pick<MemorySearchOptions, "workspaceId" | "scope" | "now">,
    model: string,
    query: Float32Array,
  ): Map<string, ScoredSource> {
    const filter = memoryLiveFilter(options);
    return best(
      this.db
        .prepare(
          `SELECT v.entry_id AS id, v.chunk, v.vector FROM memory_chunk_vectors v
             JOIN memory_entries e ON e.id = v.entry_id
            WHERE v.workspace_id = ? AND v.model = ? AND ${filter.sql}`,
        )
        .iterate(options.workspaceId, model, ...filter.args) as Iterable<{
        id: string;
        chunk: number;
        vector: Buffer;
      }>,
      query,
    );
  }

  /** Vector rows per corpus, for operations and tests. */
  counts(): { knowledge: number; memory: number } {
    const n = (table: string) =>
      (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { knowledge: n("knowledge_chunk_vectors"), memory: n("memory_chunk_vectors") };
  }
}
