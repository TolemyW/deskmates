// "Needs your confirmation" (ADR-0011 decision 4): the `memory_suggestions` table, now holding only
// gated learned items. A row takes no effect until a human applies it; nothing in it is ever in an
// index or a search result.

import {
  type BotId,
  type ConfirmationReason,
  type ConfirmationStatus,
  DeskmatesError,
  type MemoryAuthority,
  type MemoryConfirmation,
  type MemorySourceKind,
  type MemoryTrust,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  memoryReviewGroupKey,
} from "@deskmates/contracts";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { StoredScope } from "./entries.js";

interface Row {
  id: string;
  run_id: string;
  bot_id: string;
  workspace_id: string | null;
  thread_id: string | null;
  ordinal: number;
  body: string;
  status: ConfirmationStatus;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  proposed_scope: StoredScope;
  authority: MemoryAuthority;
  trust: MemoryTrust;
  source_kind: MemorySourceKind;
  reasons_json: string;
  conflicts_json: string;
  derived_from_json: string;
  entry_id: string | null;
  group_key: string | null;
}

export interface StoredConfirmation extends MemoryConfirmation {
  threadId?: ThreadId;
  /** Its position in the source run's summary. */
  ordinal: number;
  /** Its review group (amendment 3, A17); absent on a row gated before it, until backfilled. */
  groupKey?: string;
  sourceKind: MemorySourceKind;
  derivedFrom: string[];
}

function view(row: Row): StoredConfirmation {
  return {
    id: row.id,
    workspaceId: (row.workspace_id ?? "") as WorkspaceId,
    runId: row.run_id as RunId,
    botId: row.bot_id as BotId,
    ...(row.thread_id ? { threadId: row.thread_id as ThreadId } : {}),
    ordinal: row.ordinal,
    ...(row.group_key ? { groupKey: row.group_key } : {}),
    body: row.body,
    proposedScope: row.proposed_scope,
    authority: row.authority,
    trust: row.trust,
    sourceKind: row.source_kind,
    reasons: parseJson<ConfirmationReason[]>(row.reasons_json, []),
    conflictsWith: parseJson<string[]>(row.conflicts_json, []),
    derivedFrom: parseJson<string[]>(row.derived_from_json, []),
    status: row.status,
    createdAt: row.created_at,
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.entry_id ? { entryId: row.entry_id } : {}),
  };
}

export interface GateInput {
  workspaceId: WorkspaceId;
  runId: RunId;
  botId: BotId;
  threadId?: ThreadId;
  ordinal: number;
  body: string;
  proposedScope: StoredScope;
  authority: MemoryAuthority;
  trust: MemoryTrust;
  sourceKind: MemorySourceKind;
  reasons: readonly ConfirmationReason[];
  conflictsWith?: readonly string[];
  derivedFrom?: readonly string[];
}

export interface ConfirmationFilter {
  /** That tenant's suggestions only (ADR-0022 P2). */
  tenantId?: string;
  workspaceId?: WorkspaceId;
  botId?: BotId;
  status?: ConfirmationStatus;
}

const FILTER = `(? IS NULL OR workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?))
  AND (? IS NULL OR workspace_id = ?) AND (? IS NULL OR bot_id = ?)
  AND (? IS NULL OR status = ?)`;

function filterParams(options: ConfirmationFilter): (string | null)[] {
  const pair = (value: string | undefined) => [value ?? null, value ?? null];
  return [
    ...pair(options.tenantId),
    ...pair(options.workspaceId),
    ...pair(options.botId),
    ...pair(options.status),
  ];
}

export class ConfirmationStore {
  constructor(private readonly db: GatewayDb) {}

  /** Idempotent per (run, ordinal): a redelivered summary does not gate an item twice. */
  gate(input: GateInput): StoredConfirmation {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_suggestions (
           id, run_id, bot_id, workspace_id, thread_id, ordinal, body, created_at, proposed_scope,
           authority, trust, source_kind, reasons_json, conflicts_json, derived_from_json, group_key
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newId("ms"),
        input.runId,
        input.botId,
        input.workspaceId,
        input.threadId ?? null,
        input.ordinal,
        input.body,
        nowIso(),
        input.proposedScope,
        input.authority,
        input.trust,
        input.sourceKind,
        JSON.stringify(input.reasons),
        JSON.stringify(input.conflictsWith ?? []),
        JSON.stringify(input.derivedFrom ?? []),
        memoryReviewGroupKey(input),
      );
    const row = this.db
      .prepare("SELECT * FROM memory_suggestions WHERE run_id = ? AND ordinal = ?")
      .get(input.runId, input.ordinal) as Row;
    return view(row);
  }

  get(id: string): StoredConfirmation {
    const row = this.db.prepare("SELECT * FROM memory_suggestions WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new DeskmatesError("not_found", "Memory confirmation not found");
    return view(row);
  }

  /**
   * One page of the queue, newest first (`created_at DESC, id DESC`). The caller validates the
   * limit and decodes the cursor (#113 slice K2); a row past `limit` only says there is more.
   */
  list(options: ConfirmationFilter & { limit?: number; after?: readonly [string, string] }): {
    suggestions: StoredConfirmation[];
    more: boolean;
  } {
    const count = options.limit ?? 25;
    const after = options.after;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_suggestions WHERE ${FILTER}
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        ...filterParams(options),
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        count + 1,
      ) as Row[];
    return { suggestions: rows.slice(0, count).map(view), more: rows.length > count };
  }

  /** The exact number of rows under a filter: the pending total of the queue heading (A23). */
  count(options: ConfirmationFilter): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM memory_suggestions WHERE ${FILTER}`)
        .get(...filterParams(options)) as { n: number }
    ).n;
  }

  /** Return a batch-decided item to the queue (amendment 3, A19). */
  reopen(id: string): void {
    this.db
      .prepare(
        `UPDATE memory_suggestions SET status='pending', reviewed_by=NULL, reviewed_at=NULL,
           entry_id=NULL WHERE id = ?`,
      )
      .run(id);
  }

  reject(id: string, by: string): StoredConfirmation {
    const current = this.get(id);
    if (current.status === "rejected") return current;
    if (current.status !== "pending")
      throw new DeskmatesError("invalid_transition", "Memory suggestion has already been applied");
    this.db
      .prepare(
        `UPDATE memory_suggestions SET status='rejected', reviewed_by=?, reviewed_at=?
         WHERE id=? AND status='pending'`,
      )
      .run(by, nowIso(), id);
    return this.get(id);
  }

  applied(id: string, by: string, entryId: string): StoredConfirmation {
    const result = this.db
      .prepare(
        `UPDATE memory_suggestions SET status='applied', reviewed_by=?, reviewed_at=?, entry_id=?
         WHERE id=? AND status='pending'`,
      )
      .run(by, nowIso(), entryId, id);
    if (result.changes !== 1)
      throw new DeskmatesError("invalid_transition", "Memory suggestion was reviewed concurrently");
    return this.get(id);
  }
}
