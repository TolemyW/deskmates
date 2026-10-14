// Learned memory entries and their immutable version rows (ADR-0011 decisions 6, 7 and 10). Every
// query here is keyed by workspace: nothing reads an entry of workspace B while serving A.

import {
  type BotId,
  DeskmatesError,
  type MemoryAuthority,
  type MemoryEffectiveBasis,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryEntrySource,
  type MemorySourceKind,
  type MemorySupersession,
  type MemorySupersessionReason,
  type MemoryTrust,
  type MemoryVersion,
  type MemoryVersionOp,
  type PinnedCandidate,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  memoryTopic,
  normaliseMemoryBody,
} from "@deskmates/contracts";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export type StoredScope = MemoryEntry["scope"];

interface EntryRow {
  id: string;
  workspace_id: string;
  scope: StoredScope;
  kind: MemoryEntryKind;
  bot_id: string | null;
  thread_id: string | null;
  body: string;
  authority: MemoryAuthority;
  trust: MemoryTrust;
  source_run_id: string | null;
  source_kind: MemorySourceKind;
  derived_from_json: string;
  observed_at: string;
  valid_from: string;
  invalid_at: string | null;
  superseded_by: string | null;
  last_confirmed_at: string | null;
  ttl_seconds: number | null;
  version: number;
  tombstoned: number;
  episode_id: string | null;
  learned_by: string | null;
  fact_key: string | null;
  effective_at: string | null;
  effective_basis: MemoryEffectiveBasis;
  created_at: string;
  topic: string | null;
  topic_label: string | null;
}

interface SourceRow {
  entry_id: string;
  source_run_id: string | null;
  ordinal: number | null;
  source_kind: MemorySourceKind;
  trust: MemoryTrust;
  effective_at: string;
  effective_basis: MemoryEffectiveBasis;
  recorded_at: string;
}

interface SupersessionRow {
  id: string;
  entry_id: string;
  winner_id: string;
  fact_key: string;
  reason: MemorySupersessionReason;
  entry_effective_at: string;
  winner_effective_at: string;
  decided_by: string;
  created_at: string;
}

interface VersionRow {
  entry_id: string;
  version: number;
  op: MemoryVersionOp;
  body: string;
  authority: MemoryAuthority;
  trust: MemoryTrust;
  source_kind: MemorySourceKind;
  redacted: number;
  by: string;
  created_at: string;
}

/** An entry as operator views and tests see it; `episodeId` marks distilled task state. */
export interface StoredEntry extends MemoryEntry {
  episodeId?: string;
  effectiveAt: string;
  effectiveBasis: MemoryEffectiveBasis;
  /** When the Gateway stored it; the second key of the recency order (A9). */
  ingestedAt: string;
}

function toEntry(row: EntryRow): StoredEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    scope: row.scope,
    kind: row.kind,
    ...(row.bot_id ? { botId: row.bot_id as BotId } : {}),
    ...(row.thread_id ? { threadId: row.thread_id as ThreadId } : {}),
    body: row.body,
    authority: row.authority,
    trust: row.trust,
    ...(row.source_run_id ? { sourceRunId: row.source_run_id as RunId } : {}),
    sourceKind: row.source_kind,
    derivedFrom: parseJson<string[]>(row.derived_from_json, []),
    observedAt: row.observed_at,
    validFrom: row.valid_from,
    ...(row.invalid_at ? { invalidAt: row.invalid_at } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.last_confirmed_at ? { lastConfirmedAt: row.last_confirmed_at } : {}),
    ...(row.ttl_seconds ? { ttlSeconds: row.ttl_seconds } : {}),
    version: row.version,
    tombstoned: row.tombstoned === 1,
    ...(row.learned_by ? { learnedBy: row.learned_by } : {}),
    ...(row.episode_id ? { episodeId: row.episode_id } : {}),
    ...(row.fact_key ? { factKey: row.fact_key } : {}),
    effectiveAt: row.effective_at ?? row.observed_at,
    effectiveBasis: row.effective_basis,
    ingestedAt: row.created_at,
    ...(row.topic ? { topic: row.topic, topicLabel: row.topic_label ?? row.topic } : {}),
  };
}

function toVersion(row: VersionRow): MemoryVersion {
  return {
    entryId: row.entry_id,
    version: row.version,
    op: row.op,
    body: row.body,
    authority: row.authority,
    trust: row.trust,
    sourceKind: row.source_kind,
    redacted: row.redacted === 1,
    by: row.by,
    createdAt: row.created_at,
  };
}

/** The bot whose run learned an entry, for "learned by X from run Y". */
const SELECT_ENTRY = `SELECT e.*, b.name AS learned_by FROM memory_entries e
  LEFT JOIN runs r ON r.id = e.source_run_id
  LEFT JOIN bots b ON b.id = r.bot_id`;

export interface NewEntry {
  workspaceId: WorkspaceId;
  scope: StoredScope;
  kind: MemoryEntryKind;
  botId?: BotId;
  threadId?: ThreadId;
  body: string;
  authority: MemoryAuthority;
  trust: MemoryTrust;
  sourceRunId?: RunId;
  sourceKind: MemorySourceKind;
  derivedFrom?: readonly string[];
  observedAt?: string;
  ttlSeconds?: number;
  lastConfirmedAt?: string;
  op?: MemoryVersionOp;
  by: string;
  /** Recency fields (amendment 2); a plain insert leaves them to their defaults. */
  id?: string;
  factKey?: string;
  effectiveAt?: string;
  effectiveBasis?: MemoryEffectiveBasis;
  /** Its position in the source run's summary, recorded on its first source row (A8). */
  ordinal?: number;
  /** Stored already closed: an older arrival or a lower-trust copy (A9, A10). */
  invalidAt?: string;
  ingestedAt?: string;
}

export interface EntryPatch {
  body?: string;
  authority?: MemoryAuthority;
  trust?: MemoryTrust;
  sourceKind?: MemorySourceKind;
  lastConfirmedAt?: string;
  /** A bot-experience candidate becomes a note (human confirmation, consolidation). */
  promoteCandidate?: boolean;
}

export interface EntryFilter {
  workspaceId: WorkspaceId;
  botId?: BotId;
  scope?: StoredScope;
  includeTombstoned?: boolean;
}

/** The operator list's server-side filters (amendment 3, A20 and A23). */
export interface EntryPageFilter extends EntryFilter {
  threadId?: ThreadId;
  /** A topic key (A20). */
  topic?: string;
}

const PAGE_FILTER = `e.workspace_id = ?
  AND (? IS NULL OR e.scope = ?)
  AND (? IS NULL OR e.bot_id = ?)
  AND (? IS NULL OR e.thread_id = ?)
  AND (? IS NULL OR e.topic = ?)
  AND (? = 1 OR e.tombstoned = 0)`;

function pageFilterParams(filter: EntryPageFilter): (string | number | null)[] {
  const pair = (value: string | undefined) => [value ?? null, value ?? null];
  return [
    filter.workspaceId,
    ...pair(filter.scope),
    ...pair(filter.botId),
    ...pair(filter.threadId),
    ...pair(filter.topic),
    filter.includeTombstoned ? 1 : 0,
  ];
}

export class MemoryEntryStore {
  constructor(readonly db: GatewayDb) {}

  insert(input: NewEntry): StoredEntry {
    const id = input.id ?? newId("mem");
    const now = input.ingestedAt ?? nowIso();
    const observed = input.observedAt ?? input.effectiveAt ?? now;
    const effectiveAt = input.effectiveAt ?? observed;
    const effectiveBasis = input.effectiveBasis ?? "ingest";
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memory_entries (
             id, workspace_id, scope, kind, bot_id, thread_id, body, normalized_body, authority,
             trust, source_run_id, source_kind, derived_from_json, observed_at, valid_from,
             last_confirmed_at, ttl_seconds, version, created_at, updated_at, fact_key,
             effective_at, effective_basis, invalid_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.workspaceId,
          input.scope,
          input.kind,
          input.botId ?? null,
          input.threadId ?? null,
          input.body,
          normaliseMemoryBody(input.body),
          input.authority,
          input.trust,
          input.sourceRunId ?? null,
          input.sourceKind,
          JSON.stringify(input.derivedFrom ?? []),
          observed,
          observed,
          input.lastConfirmedAt ?? null,
          input.ttlSeconds ?? null,
          now,
          now,
          input.factKey ?? null,
          effectiveAt,
          effectiveBasis,
          input.invalidAt ?? null,
        );
      this.insertVersion(id, 1, input.op ?? "create", {
        body: input.body,
        authority: input.authority,
        trust: input.trust,
        sourceKind: input.sourceKind,
        by: input.by,
        at: now,
      });
      this.addSource({
        workspaceId: input.workspaceId,
        entryId: id,
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
        sourceKind: input.sourceKind,
        trust: input.trust,
        effectiveAt,
        effectiveBasis,
        recordedAt: now,
      });
    })();
    return this.mustGet(id);
  }

  /** A10: one more source of an entry; it never changes the entry's trust, authority or TTL. */
  addSource(source: MemoryEntrySource & { workspaceId: WorkspaceId }): void {
    this.db
      .prepare(
        `INSERT INTO memory_entry_sources (workspace_id, entry_id, source_run_id, ordinal,
           source_kind, trust, effective_at, effective_basis, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        source.workspaceId,
        source.entryId,
        source.sourceRunId ?? null,
        source.ordinal ?? null,
        source.sourceKind,
        source.trust,
        source.effectiveAt,
        source.effectiveBasis,
        source.recordedAt,
      );
  }

  sources(workspaceId: WorkspaceId, entryId: string): MemoryEntrySource[] {
    const rows = this.db
      .prepare(
        `SELECT entry_id, source_run_id, ordinal, source_kind, trust, effective_at,
           effective_basis, recorded_at
         FROM memory_entry_sources WHERE workspace_id = ? AND entry_id = ? ORDER BY seq`,
      )
      .all(workspaceId, entryId) as SourceRow[];
    return rows.map((row) => ({
      entryId: row.entry_id,
      ...(row.source_run_id ? { sourceRunId: row.source_run_id as RunId } : {}),
      ...(row.ordinal === null ? {} : { ordinal: row.ordinal }),
      sourceKind: row.source_kind,
      trust: row.trust,
      effectiveAt: row.effective_at,
      effectiveBasis: row.effective_basis,
      recordedAt: row.recorded_at,
    }));
  }

  /** The entry an item of a run's summary already went to (A8 idempotency). */
  entryForItem(runId: RunId, ordinal: number): StoredEntry | undefined {
    const row = this.db
      .prepare("SELECT entry_id FROM memory_entry_sources WHERE source_run_id = ? AND ordinal = ?")
      .get(runId, ordinal) as { entry_id: string } | undefined;
    return row ? this.get(row.entry_id) : undefined;
  }

  /** The current note of one fact in one store (A8): at most one, by the unique index. */
  currentFor(
    workspaceId: WorkspaceId,
    scope: StoredScope,
    owner: { botId?: BotId; threadId?: ThreadId },
    factKey: string,
  ): StoredEntry | undefined {
    const row = this.db
      .prepare(
        `${SELECT_ENTRY}
         WHERE e.workspace_id = ? AND e.scope = ? AND COALESCE(e.bot_id, '') = ?
           AND COALESCE(e.thread_id, '') = ? AND e.fact_key = ? AND e.kind = 'note'
           AND e.tombstoned = 0 AND e.invalid_at IS NULL AND e.episode_id IS NULL`,
      )
      .get(
        workspaceId,
        scope,
        scope === "bot" ? (owner.botId ?? "") : "",
        scope === "task" ? (owner.threadId ?? "") : "",
        factKey,
      ) as EntryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  /** Rows written before amendment 2, oldest first (backfill). */
  unkeyed(workspaceId: WorkspaceId): StoredEntry[] {
    const rows = this.db
      .prepare(
        `${SELECT_ENTRY} WHERE e.workspace_id = ? AND e.effective_at IS NULL
         ORDER BY e.observed_at, e.created_at, e.id`,
      )
      .all(workspaceId) as EntryRow[];
    return rows.map(toEntry);
  }

  setFactKey(id: string, factKey: string | undefined, effectiveAt: string): void {
    this.db
      .prepare("UPDATE memory_entries SET fact_key = ?, effective_at = ? WHERE id = ?")
      .run(factKey ?? null, effectiveAt, id);
  }

  /** A later independent source keeps the value current against late older arrivals (A10). */
  advanceEffective(id: string, effectiveAt: string, basis: MemoryEffectiveBasis): void {
    this.db
      .prepare(
        `UPDATE memory_entries SET effective_at = ?, effective_basis = ?
         WHERE id = ? AND (effective_at IS NULL OR effective_at < ?)`,
      )
      .run(effectiveAt, basis, id, effectiveAt);
  }

  /**
   * Close a current note (A12): its interval ends and a `supersede` version records it, body
   * unchanged. The link to its successor is written by `linkSupersession` once that exists.
   */
  closeForSupersession(id: string, at: string, by: string): void {
    const current = this.mustGet(id);
    const version = current.version + 1;
    this.db
      .prepare("UPDATE memory_entries SET invalid_at = ?, version = ?, updated_at = ? WHERE id = ?")
      .run(at, version, at, id);
    this.insertVersion(id, version, "supersede", {
      body: current.body,
      authority: current.authority,
      trust: current.trust,
      sourceKind: current.sourceKind,
      by,
      at,
    });
  }

  /** Point a closed note at what replaced it and write the receipt (A9, A12). */
  linkSupersession(input: {
    entry: StoredEntry;
    winner: StoredEntry;
    reason: MemorySupersessionReason;
    by: string;
    at: string;
  }): void {
    this.db
      .prepare("UPDATE memory_entries SET superseded_by = ? WHERE id = ?")
      .run(input.winner.id, input.entry.id);
    this.db
      .prepare(
        `INSERT INTO memory_supersessions (id, workspace_id, entry_id, winner_id, fact_key, reason,
           entry_effective_at, winner_effective_at, decided_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newId("msup"),
        input.entry.workspaceId,
        input.entry.id,
        input.winner.id,
        input.winner.factKey ?? input.entry.factKey ?? "",
        input.reason,
        input.entry.effectiveAt,
        input.winner.effectiveAt,
        input.by,
        input.at,
      );
  }

  /** Reopen a closed note (undo of a supersession, A12). */
  reopen(id: string, at: string): void {
    this.db
      .prepare(
        "UPDATE memory_entries SET invalid_at = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?",
      )
      .run(at, id);
  }

  /** Receipts in which the entry was closed or took another's place, newest first. */
  supersessions(workspaceId: WorkspaceId, entryId: string): MemorySupersession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_supersessions WHERE workspace_id = ? AND entry_id = ?
         UNION ALL
         SELECT * FROM memory_supersessions WHERE workspace_id = ? AND winner_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(workspaceId, entryId, workspaceId, entryId) as SupersessionRow[];
    return rows.map((row) => ({
      id: row.id,
      entryId: row.entry_id,
      winnerId: row.winner_id,
      factKey: row.fact_key,
      reason: row.reason,
      entryEffectiveAt: row.entry_effective_at,
      winnerEffectiveAt: row.winner_effective_at,
      decidedBy: row.decided_by,
      createdAt: row.created_at,
    }));
  }

  get(id: string): StoredEntry | undefined {
    const row = this.db.prepare(`${SELECT_ENTRY} WHERE e.id = ?`).get(id) as EntryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  mustGet(id: string): StoredEntry {
    const entry = this.get(id);
    if (!entry) throw new DeskmatesError("not_found", "Memory entry not found", { id });
    return entry;
  }

  /** Entry of this workspace, or not found: an id from another workspace is not visible here. */
  mustGetIn(workspaceId: WorkspaceId, id: string): StoredEntry {
    const entry = this.get(id);
    if (!entry || entry.workspaceId !== workspaceId)
      throw new DeskmatesError("not_found", "Memory entry not found", { id });
    return entry;
  }

  list(filter: EntryFilter): StoredEntry[] {
    const rows = this.db
      .prepare(
        `${SELECT_ENTRY}
         WHERE e.workspace_id = ?
           AND (? IS NULL OR e.scope = ?)
           AND (? IS NULL OR e.bot_id = ?)
           AND (? = 1 OR e.tombstoned = 0)
         ORDER BY e.observed_at DESC, e.id`,
      )
      .all(
        filter.workspaceId,
        filter.scope ?? null,
        filter.scope ?? null,
        filter.botId ?? null,
        filter.botId ?? null,
        filter.includeTombstoned ? 1 : 0,
      ) as EntryRow[];
    return rows.map(toEntry);
  }

  /** A20: give entries written or edited since their topic was last computed their topic. */
  ensureTopics(workspaceId: WorkspaceId): void {
    const rows = this.db
      .prepare("SELECT id, body FROM memory_entries WHERE workspace_id = ? AND topic_set = 0")
      .all(workspaceId) as { id: string; body: string }[];
    if (rows.length === 0) return;
    const update = this.db.prepare(
      "UPDATE memory_entries SET topic = ?, topic_label = ?, topic_set = 1 WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const topic = memoryTopic(row.body);
        update.run(topic?.key ?? null, topic?.label ?? null, row.id);
      }
    })();
  }

  /**
   * One page of the operator list (A23): `observed_at DESC, id DESC`, filtered on the server.
   * A row past `limit` only says there is more.
   */
  page(filter: EntryPageFilter & { limit: number; after?: readonly [string, string] }): {
    entries: StoredEntry[];
    more: boolean;
  } {
    if (filter.topic !== undefined) this.ensureTopics(filter.workspaceId);
    const after = filter.after;
    const rows = this.db
      .prepare(
        `${SELECT_ENTRY} WHERE ${PAGE_FILTER}
           AND (? IS NULL OR e.observed_at < ? OR (e.observed_at = ? AND e.id < ?))
         ORDER BY e.observed_at DESC, e.id DESC LIMIT ?`,
      )
      .all(
        ...pageFilterParams(filter),
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        filter.limit + 1,
      ) as EntryRow[];
    return { entries: rows.slice(0, filter.limit).map(toEntry), more: rows.length > filter.limit };
  }

  /** A20: topics of the entries not forgotten, most entries first, with an exact total. */
  topics(
    filter: Omit<EntryPageFilter, "topic" | "includeTombstoned">,
    page: { offset: number; limit: number },
  ): { topics: { key: string; label: string; count: number }[]; total: number } {
    this.ensureTopics(filter.workspaceId);
    const where = `${PAGE_FILTER} AND e.topic IS NOT NULL`;
    const params = pageFilterParams({ ...filter, includeTombstoned: false });
    const rows = this.db
      .prepare(
        `SELECT e.topic AS key, MIN(e.topic_label) AS label, COUNT(*) AS count
         FROM memory_entries e WHERE ${where}
         GROUP BY e.topic ORDER BY count DESC, e.topic LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset) as { key: string; label: string; count: number }[];
    const total = (
      this.db
        .prepare(`SELECT COUNT(DISTINCT e.topic) AS n FROM memory_entries e WHERE ${where}`)
        .get(...params) as { n: number }
    ).n;
    return { topics: rows, total };
  }

  /**
   * A live entry with the same normalised body in the same store (scope, bot, thread) and at the
   * same trust: duplicates never merge across trust levels (decision 3, A10).
   */
  findDuplicate(
    workspaceId: WorkspaceId,
    scope: StoredScope,
    body: string,
    owner: { botId?: BotId; threadId?: ThreadId },
    trust: MemoryTrust,
  ): StoredEntry | undefined {
    const row = this.db
      .prepare(
        `${SELECT_ENTRY}
         WHERE e.workspace_id = ? AND e.scope = ? AND e.normalized_body = ? AND e.trust = ?
           AND e.tombstoned = 0 AND e.invalid_at IS NULL AND e.episode_id IS NULL
           AND (? IS NULL OR e.bot_id = ?) AND (? IS NULL OR e.thread_id = ?)
         ORDER BY e.created_at, e.id LIMIT 1`,
      )
      .get(
        workspaceId,
        scope,
        normaliseMemoryBody(body),
        trust,
        owner.botId ?? null,
        owner.botId ?? null,
        owner.threadId ?? null,
        owner.threadId ?? null,
      ) as EntryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  /**
   * Live notes a run of `botId` could have pinned: this workspace's facts, this bot's own
   * experience, and task state of this thread that is not yet an episode. Trust, validity and
   * TTL are applied by the pure assembler, which also refuses everything untrusted.
   */
  pinCandidates(workspaceId: WorkspaceId, botId: BotId, threadId?: ThreadId): PinnedCandidate[] {
    const rows = this.db
      .prepare(
        `${SELECT_ENTRY}
         WHERE e.workspace_id = ? AND e.kind = 'note' AND e.tombstoned = 0
           AND (e.scope = 'workspace'
                OR (e.scope = 'bot' AND e.bot_id = ?)
                OR (e.scope = 'task' AND e.thread_id = ? AND e.episode_id IS NULL))`,
      )
      .all(workspaceId, botId, threadId ?? null) as EntryRow[];
    return rows.map(toEntry);
  }

  /** A new version: the entry row moves, the old version row stays as it was. */
  appendVersion(id: string, op: MemoryVersionOp, patch: EntryPatch, by: string): StoredEntry {
    const now = nowIso();
    this.db.transaction(() => {
      const current = this.mustGet(id);
      const next = {
        body: patch.body ?? current.body,
        authority: patch.authority ?? current.authority,
        trust: patch.trust ?? current.trust,
        sourceKind: patch.sourceKind ?? current.sourceKind,
      };
      const version = current.version + 1;
      this.db
        .prepare(
          `UPDATE memory_entries
           SET body = ?, normalized_body = ?, authority = ?, trust = ?, source_kind = ?,
               last_confirmed_at = COALESCE(?, last_confirmed_at), version = ?, updated_at = ?,
               topic_set = 0,
               kind = CASE WHEN ? = 1 AND kind = 'candidate' THEN 'note' ELSE kind END
           WHERE id = ?`,
        )
        .run(
          next.body,
          normaliseMemoryBody(next.body),
          next.authority,
          next.trust,
          next.sourceKind,
          patch.lastConfirmedAt ?? null,
          version,
          now,
          patch.promoteCandidate ? 1 : 0,
          id,
        );
      this.insertVersion(id, version, op, { ...next, by, at: now });
    })();
    return this.mustGet(id);
  }

  /** A23: one page of an entry's versions, newest first; `before` is the last version shown. */
  versionsPage(
    id: string,
    page: { limit: number; before?: number },
  ): { versions: MemoryVersion[]; more: boolean } {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_versions WHERE entry_id = ? AND (? IS NULL OR version < ?)
         ORDER BY version DESC LIMIT ?`,
      )
      .all(id, page.before ?? null, page.before ?? null, page.limit + 1) as VersionRow[];
    return { versions: rows.slice(0, page.limit).map(toVersion), more: rows.length > page.limit };
  }

  versions(id: string): MemoryVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_versions WHERE entry_id = ? ORDER BY version")
      .all(id) as VersionRow[];
    return rows.map(toVersion);
  }

  version(id: string, version: number): MemoryVersion | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_versions WHERE entry_id = ? AND version = ?")
      .get(id, version) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  /** Forget: tombstone, empty the entry body and redact every version body (decision 7). */
  tombstone(id: string, by: string): StoredEntry {
    const now = nowIso();
    this.db.transaction(() => {
      const current = this.mustGet(id);
      const version = current.version + 1;
      this.db
        .prepare(
          `UPDATE memory_entries
           SET body = '', normalized_body = '', fact_key = NULL, tombstoned = 1, version = ?,
               updated_at = ?, topic = NULL, topic_label = NULL, topic_set = 1
           WHERE id = ?`,
        )
        .run(version, now, id);
      // The fact key is made of the body's words: a forgotten body leaves no key behind.
      this.db
        .prepare(
          `UPDATE memory_supersessions SET fact_key = ''
           WHERE workspace_id = ? AND (entry_id = ? OR winner_id = ?)`,
        )
        .run(current.workspaceId, id, id);
      this.db
        .prepare("UPDATE memory_versions SET body = '', redacted = 1 WHERE entry_id = ?")
        .run(id);
      this.insertVersion(id, version, "forget", {
        body: "",
        authority: current.authority,
        trust: current.trust,
        sourceKind: current.sourceKind,
        by,
        at: now,
        redacted: true,
      });
    })();
    return this.mustGet(id);
  }

  setEpisode(ids: readonly string[], episodeId: string): void {
    const stmt = this.db.prepare("UPDATE memory_entries SET episode_id = ? WHERE id = ?");
    for (const id of ids) stmt.run(episodeId, id);
  }

  setConsolidatedBy(ids: readonly string[], runId: RunId): void {
    const stmt = this.db.prepare("UPDATE memory_entries SET consolidated_by_run = ? WHERE id = ?");
    for (const id of ids) stmt.run(runId, id);
  }

  /** Episodes and this bot's candidates not yet taken by a consolidation run. */
  consolidationInput(workspaceId: WorkspaceId, botId: BotId): StoredEntry[] {
    const rows = this.db
      .prepare(
        `${SELECT_ENTRY}
         WHERE e.workspace_id = ? AND e.tombstoned = 0 AND e.consolidated_by_run IS NULL
           AND (e.kind = 'episode' OR (e.kind = 'candidate' AND e.bot_id = ?
             AND (e.source_run_id IS NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.id = e.source_run_id
               AND r.status IN ('succeeded','silent')
               AND r.run_type IS NOT 'memory_consolidation'))))
         ORDER BY e.observed_at, e.id`,
      )
      .all(workspaceId, botId) as EntryRow[];
    return rows.map(toEntry);
  }

  /** Live task notes of a thread not yet distilled (episodes, decision 11). */
  openTaskNotes(threadId: ThreadId): StoredEntry[] {
    const rows = this.db
      .prepare(
        `${SELECT_ENTRY}
         WHERE e.thread_id = ? AND e.scope = 'task' AND e.kind = 'note'
           AND e.tombstoned = 0 AND e.episode_id IS NULL
         ORDER BY e.observed_at, e.id`,
      )
      .all(threadId) as EntryRow[];
    return rows.map(toEntry);
  }

  private insertVersion(
    id: string,
    version: number,
    op: MemoryVersionOp,
    v: {
      body: string;
      authority: MemoryAuthority;
      trust: MemoryTrust;
      sourceKind: MemorySourceKind;
      by: string;
      at: string;
      redacted?: boolean;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_versions (entry_id, version, op, body, authority, trust, source_kind,
           redacted, by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        version,
        op,
        v.body,
        v.authority,
        v.trust,
        v.sourceKind,
        v.redacted ? 1 : 0,
        v.by,
        v.at,
      );
  }
}
