import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DeskmatesError,
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeProposal,
  type KnowledgeVersion,
  type RunId,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

type DocRow = {
  id: string;
  path: string;
  title: string;
  body: string;
  source_run_id: string | null;
  approved_by: string | null;
  updated_at: string;
  version: number;
};
type ProposalRow = {
  id: string;
  title: string;
  body: string;
  source_run_id: string | null;
  status: KnowledgeProposal["status"];
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  document_id: string | null;
};
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
type VersionRow = {
  document_id: string;
  version: number;
  path: string;
  title: string;
  body: string;
  source_run_id: string | null;
  approved_by: string;
  created_at: string;
};

/**
 * A keyset page read with `LIMIT limit + 1`: each row with its sort key and tie-breaker. The
 * route turns the keys into a scoped cursor (`api/pagination.ts`); the store never sees one.
 */
export interface KeyedRows<T> {
  rows: { item: T; key: [string, string] }[];
}
/** The keyset position after which a page starts: `[sortKey, id]`. */
export type KeysetAfter = readonly [string, string];
/** Search results are bounded per request: offset over the bm25 rank, never the whole set. */
export const KNOWLEDGE_SEARCH_LIMIT = { default: 25, max: 100 } as const;

/** An FTS5 match of up to 16 quoted terms, or undefined when the query has none. */
function ftsMatch(query: string): string | undefined {
  if (query.length > 500) throw new DeskmatesError("validation", "Knowledge query is too long");
  const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16) ?? [];
  return tokens.length ? tokens.map((token) => `"${token}"`).join(" OR ") : undefined;
}

export function validateKnowledge(title: unknown, body: unknown): { title: string; body: string } {
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200 ||
    typeof body !== "string" ||
    !body.trim() ||
    Buffer.byteLength(body) > 64 * 1024
  ) {
    throw new DeskmatesError(
      "validation",
      "Knowledge requires a title (1–200 characters) and Markdown body (1–65536 bytes)",
    );
  }
  return { title: title.trim(), body };
}
const proposalView = (r: ProposalRow): KnowledgeProposal => ({
  id: r.id,
  title: r.title,
  body: r.body,
  status: r.status,
  createdAt: r.created_at,
  ...(r.source_run_id ? { sourceRunId: r.source_run_id as RunId } : {}),
  ...(r.reviewed_by ? { reviewedBy: r.reviewed_by } : {}),
  ...(r.reviewed_at ? { reviewedAt: r.reviewed_at } : {}),
  ...(r.document_id ? { documentId: r.document_id } : {}),
});

/**
 * SQLite publishes pointers to immutable Markdown versions; uncommitted files are never served.
 * Every method takes the tenant whose Knowledge it reads or writes (ADR-0022 P2); a document or
 * proposal of another tenant is "not found", exactly like a missing one.
 */
export class KnowledgeStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly directory?: string,
  ) {}

  propose(tenantId: string, title: unknown, body: unknown, sourceRunId?: RunId): KnowledgeProposal {
    const value = validateKnowledge(title, body);
    const id = `kp_${randomUUID().replaceAll("-", "")}`;
    this.db
      .prepare(
        "INSERT INTO knowledge_proposals(id,tenant_id,title,body,source_run_id,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, tenantId, value.title, value.body, sourceRunId ?? null, new Date().toISOString());
    return this.proposal(tenantId, id);
  }
  proposal(tenantId: string, id: string): KnowledgeProposal {
    const row = this.db
      .prepare("SELECT * FROM knowledge_proposals WHERE id = ? AND tenant_id = ?")
      .get(id, tenantId) as ProposalRow | undefined;
    if (!row) throw new DeskmatesError("not_found", "Knowledge proposal not found");
    return proposalView(row);
  }
  /** Proposals with this status, newest first, `created_at DESC, id DESC`; `limit + 1` rows. */
  proposalRows(
    tenantId: string,
    status: KnowledgeProposal["status"],
    limit: number,
    after?: KeysetAfter,
  ): KeyedRows<KnowledgeProposal> {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_proposals
         WHERE tenant_id = ? AND status = ?
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        tenantId,
        status,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        limit + 1,
      ) as ProposalRow[];
    return {
      rows: rows.map((row) => ({ item: proposalView(row), key: [row.created_at, row.id] })),
    };
  }
  /** The whole queue's size under the same filter: one indexed count, not a page length. */
  proposalCount(tenantId: string, status: KnowledgeProposal["status"]): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM knowledge_proposals WHERE tenant_id = ? AND status = ?")
        .get(tenantId, status) as { n: number }
    ).n;
  }
  private writeVersion(id: string, version: number, body: string): string {
    const path = `${id}.${version}.${randomUUID()}.md`;
    if (this.directory) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const parentFd = openSync(dirname(this.directory), "r");
      try {
        fsyncSync(parentFd);
      } finally {
        closeSync(parentFd);
      }
      // Exclusive creation avoids replacing a version another reader may still use.
      writeFileSync(join(this.directory, path), body, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      const directoryFd = openSync(this.directory, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    return path;
  }
  review(
    tenantId: string,
    id: string,
    decision: "approve" | "reject",
    by: string,
  ): KnowledgeProposal {
    return this.db.transaction(() => {
      const proposal = this.proposal(tenantId, id);
      if (proposal.status !== "pending")
        throw new DeskmatesError(
          "invalid_transition",
          "Knowledge proposal has already been reviewed",
        );
      const now = new Date().toISOString();
      let documentId: string | null = null;
      if (decision === "approve") {
        documentId = `kb_${randomUUID().replaceAll("-", "")}`;
        const path = this.writeVersion(documentId, 1, proposal.body);
        this.db
          .prepare(
            "INSERT INTO knowledge_docs(id,tenant_id,path,title,body,source_run_id,approved_by,updated_at,version) VALUES (?,?,?,?,?,?,?,?,1)",
          )
          .run(
            documentId,
            tenantId,
            path,
            proposal.title,
            proposal.body,
            proposal.sourceRunId ?? null,
            by,
            now,
          );
        this.db
          .prepare(
            `INSERT INTO knowledge_versions(
               document_id,version,path,title,body,source_run_id,approved_by,created_at
             ) VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run(
            documentId,
            1,
            path,
            proposal.title,
            proposal.body,
            proposal.sourceRunId ?? null,
            by,
            now,
          );
      }
      this.db
        .prepare(
          "UPDATE knowledge_proposals SET status=?,reviewed_by=?,reviewed_at=?,document_id=? WHERE id=? AND tenant_id=?",
        )
        .run(decision === "approve" ? "approved" : "rejected", by, now, documentId, id, tenantId);
      return this.proposal(tenantId, id);
    })();
  }
  read(tenantId: string, id: string): KnowledgeDocument {
    const row = this.db
      .prepare(
        "SELECT * FROM knowledge_docs WHERE id=? AND tenant_id=? AND approved_by IS NOT NULL",
      )
      .get(id, tenantId) as DocRow | undefined;
    if (!row) throw new DeskmatesError("not_found", "Published knowledge not found");
    if (this.directory) {
      // Legacy/malformed paths never escape the managed directory.
      if (!/^kb_[a-f0-9]+\.\d+\.[a-f0-9-]+\.md$/.test(row.path))
        throw new DeskmatesError("validation", "Invalid knowledge storage path");
      let stored: string;
      try {
        stored = readFileSync(join(this.directory, row.path), "utf8");
      } catch {
        throw new DeskmatesError("invalid_transition", "Knowledge Markdown is unavailable");
      }
      if (stored !== row.body)
        throw new DeskmatesError("invalid_transition", "Knowledge Markdown and index disagree");
    }
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      version: row.version,
      approvedBy: row.approved_by as string,
      updatedAt: row.updated_at,
      ...(row.source_run_id ? { sourceRunId: row.source_run_id as RunId } : {}),
    };
  }
  /** Published documents, most recently updated first, `updated_at DESC, id DESC`. */
  documentRows(tenantId: string, limit: number, after?: KeysetAfter): KeyedRows<KnowledgeHit> {
    const rows = this.db
      .prepare(
        `SELECT id,title,substr(body,1,300) AS excerpt,version,updated_at
         FROM knowledge_docs
         WHERE tenant_id = ? AND approved_by IS NOT NULL
           AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(
        tenantId,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        limit + 1,
      ) as (KnowledgeHit & { updated_at: string })[];
    return {
      rows: rows.map(({ updated_at, ...hit }) => ({ item: hit, key: [updated_at, hit.id] })),
    };
  }
  documentCount(tenantId: string): number {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM knowledge_docs WHERE tenant_id = ? AND approved_by IS NOT NULL",
        )
        .get(tenantId) as { n: number }
    ).n;
  }
  /** Older versions first page by `version DESC`; the bare version cursor is scoped by `id`. */
  history(tenantId: string, id: string, cursor?: string, limit = 25): Page<KnowledgeVersion> {
    this.read(tenantId, id);
    const count = limit;
    let before = Number.POSITIVE_INFINITY;
    if (cursor) {
      const parsed = Number(cursor);
      if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new DeskmatesError("validation", "Invalid history cursor");
      before = parsed;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_versions
         WHERE document_id = ? AND version < ?
         ORDER BY version DESC LIMIT ?`,
      )
      .all(id, before, count + 1) as VersionRow[];
    const visible = rows.slice(0, count);
    return {
      items: visible.map((row) => ({
        documentId: row.document_id,
        version: row.version,
        path: row.path,
        title: row.title,
        body: row.body,
        approvedBy: row.approved_by,
        createdAt: row.created_at,
        ...(row.source_run_id ? { sourceRunId: row.source_run_id as RunId } : {}),
      })),
      ...(rows.length > count && visible.length
        ? { nextCursor: String(visible[visible.length - 1]?.version) }
        : {}),
    };
  }
  cleanupOrphanVersions(): { removed: number; retained: number } {
    if (!this.directory || !existsSync(this.directory)) return { removed: 0, retained: 0 };
    const referenced = new Set(
      (
        this.db
          .prepare("SELECT path FROM knowledge_docs UNION SELECT path FROM knowledge_versions")
          .all() as { path: string }[]
      ).map((row) => row.path),
    );
    let removed = 0;
    let retained = 0;
    for (const name of readdirSync(this.directory)) {
      if (!/^kb_[a-f0-9]+\.\d+\.[a-f0-9-]+\.md$/.test(name)) continue;
      if (referenced.has(name)) {
        retained += 1;
        continue;
      }
      unlinkSync(join(this.directory, name));
      removed += 1;
    }
    return { removed, retained };
  }
  /**
   * Full-text search inside one tenant. The tenant condition is part of the same query as the
   * MATCH, so ranking and the limit apply to this tenant's documents only: another tenant's
   * matches can neither appear nor push this tenant's results out of the top K.
   */
  search(tenantId: string, query: string, limit = 5): KnowledgeHit[] {
    const match = ftsMatch(query);
    if (!match) return [];
    return this.db
      .prepare(
        "SELECT d.id,d.title,substr(d.body,1,300) AS excerpt,d.version FROM knowledge_fts f JOIN knowledge_docs d ON d.rowid=f.rowid WHERE knowledge_fts MATCH ? AND d.tenant_id = ? AND d.approved_by IS NOT NULL ORDER BY bm25(knowledge_fts),d.id LIMIT ?",
      )
      .all(match, tenantId, Math.max(1, Math.min(20, Math.floor(limit) || 5))) as KnowledgeHit[];
  }
  /**
   * The operator's search, paged over the same tenant-scoped rank (`bm25, id`) with the honest
   * number of matches. The run tool keeps `search` and its top-5 contract unchanged.
   */
  searchPage(
    tenantId: string,
    query: string,
    offset: number,
    limit: number,
  ): { items: KnowledgeHit[]; total: number } {
    const match = ftsMatch(query);
    if (!match) return { items: [], total: 0 };
    const from =
      "FROM knowledge_fts f JOIN knowledge_docs d ON d.rowid=f.rowid WHERE knowledge_fts MATCH ? AND d.tenant_id = ? AND d.approved_by IS NOT NULL";
    const total = (
      this.db.prepare(`SELECT count(*) AS n ${from}`).get(match, tenantId) as { n: number }
    ).n;
    const items = this.db
      .prepare(
        `SELECT d.id,d.title,substr(d.body,1,300) AS excerpt,d.version ${from} ORDER BY bm25(knowledge_fts),d.id LIMIT ? OFFSET ?`,
      )
      .all(match, tenantId, limit, offset) as KnowledgeHit[];
    return { items, total };
  }
  edit(
    tenantId: string,
    id: string,
    title: unknown,
    body: unknown,
    version: number,
    by: string,
  ): KnowledgeDocument {
    const value = validateKnowledge(title, body);
    return this.db.transaction(() => {
      const current = this.read(tenantId, id);
      if (current.version !== version)
        throw new DeskmatesError("invalid_transition", "Knowledge changed; reload before editing");
      const path = this.writeVersion(id, version + 1, value.body);
      this.db
        .prepare(
          "UPDATE knowledge_docs SET title=?,body=?,path=?,version=version+1,approved_by=?,updated_at=? WHERE id=? AND tenant_id=?",
        )
        .run(value.title, value.body, path, by, new Date().toISOString(), id, tenantId);
      const updated = this.read(tenantId, id);
      this.db
        .prepare(
          `INSERT INTO knowledge_versions(
             document_id,version,path,title,body,source_run_id,approved_by,created_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          updated.id,
          updated.version,
          path,
          updated.title,
          updated.body,
          updated.sourceRunId ?? null,
          updated.approvedBy,
          updated.updatedAt,
        );
      return updated;
    })();
  }
}
