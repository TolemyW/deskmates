// `memory_search` (ADR-0011 decisions 5, 9 and 10): FTS5 over learned memory, scoped to one
// workspace. Trusted and untrusted entries are both returned, each marked; the sidecar wraps the
// untrusted ones. Forgotten, superseded and expired entries, task notes already distilled into an
// episode, and gated items (which are not entries at all) are never returned: search shows the
// current value of a fact only (amendment 2, A13). Liveness is decided in SQL so a page of
// results is exact and the operator list can page with a cursor (A15).

import {
  DeskmatesError,
  type MemoryScope,
  type MemorySearchHit,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

interface HitRow {
  id: string;
  version: number;
  scope: MemorySearchHit["scope"];
  kind: MemorySearchHit["kind"];
  body: string;
  authority: MemorySearchHit["authority"];
  trust: MemorySearchHit["trust"];
  observed_at: string;
  source_run_id: string | null;
  learned_by: string | null;
}

export interface MemorySearchOptions {
  workspaceId: WorkspaceId;
  query: string;
  scope?: Exclude<MemoryScope, "rule">;
  limit?: number;
  /** Hits to skip: the operator list's cursor (A15). */
  offset?: number;
  now?: Date;
}

const BASE = `SELECT e.id, e.version, e.scope, e.kind, e.body, e.authority, e.trust, e.observed_at,
    e.source_run_id, b.name AS learned_by
  FROM memory_entries e
  LEFT JOIN runs r ON r.id = e.source_run_id
  LEFT JOIN bots b ON b.id = r.bot_id`;

const FILTER = `e.workspace_id = ? AND e.tombstoned = 0 AND e.episode_id IS NULL
  AND (? IS NULL OR e.scope = ?)
  AND (e.invalid_at IS NULL OR e.invalid_at > ?)
  AND (e.ttl_seconds IS NULL
       OR julianday(COALESCE(e.last_confirmed_at, e.observed_at)) + e.ttl_seconds / 86400.0
          > julianday(?))`;

function tokensOf(query: string): string[] {
  if (query.length > 500) throw new DeskmatesError("validation", "Memory query is too long");
  return query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16) ?? [];
}

/** One page of hits and whether another exists after it. */
export function searchMemoryPage(
  db: GatewayDb,
  options: MemorySearchOptions,
): { hits: MemorySearchHit[]; more: boolean } {
  const tokens = tokensOf(options.query);
  if (tokens.length === 0) return { hits: [], more: false };
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10) || 10));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const now = (options.now ?? new Date()).toISOString();
  const scope = options.scope ?? null;
  const filter = [options.workspaceId, scope, scope, now, now];
  const match = tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ");
  const fts = db.prepare(
    `${BASE} JOIN memory_fts f ON f.rowid = e.rowid
     WHERE memory_fts MATCH ? AND ${FILTER}
     ORDER BY bm25(memory_fts), e.id LIMIT ? OFFSET ?`,
  );
  // unicode61 keeps a run of CJK characters as one token, so a CJK word inside a longer run is
  // not an FTS match; a substring scan within the same workspace covers it.
  const anyFts = fts.get(match, ...filter, 1, 0) !== undefined;
  const like = tokens.slice(0, 5);
  const rows = (
    anyFts
      ? fts.all(match, ...filter, limit + 1, offset)
      : db
          .prepare(
            `${BASE} WHERE (${like.map(() => "e.body LIKE ?").join(" OR ")}) AND ${FILTER}
             ORDER BY e.observed_at DESC, e.id LIMIT ? OFFSET ?`,
          )
          .all(
            ...like.map((token) => `%${token.replace(/[%_]/g, "")}%`),
            ...filter,
            limit + 1,
            offset,
          )
  ) as HitRow[];
  return {
    more: rows.length > limit,
    hits: rows.slice(0, limit).map((row) => ({
      id: row.id,
      version: row.version,
      scope: row.scope,
      kind: row.kind,
      body: row.body,
      authority: row.authority,
      trust: row.trust,
      observedAt: row.observed_at,
      ...(row.learned_by ? { learnedBy: row.learned_by } : {}),
      ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    })),
  };
}

/** The first page only: what a run's `memory_search` tool receives (10 by default, at most 20). */
export function searchMemory(db: GatewayDb, options: MemorySearchOptions): MemorySearchHit[] {
  return searchMemoryPage(db, {
    ...options,
    limit: Math.min(20, options.limit ?? 10),
    offset: 0,
  }).hits;
}
