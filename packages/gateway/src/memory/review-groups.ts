// Review groups and batch dispositions of "needs your confirmation" (ADR-0011 amendment 3,
// A17 to A19). A group is every pending gated item of one workspace with the same group key.
// A batch decides at most 50 of them, oldest first, after a preview whose token it must name;
// it is one transaction, idempotent per token, audited, and undoable as a whole while its items
// are as it left them. Nothing here applies an item without a human command, deletes an item,
// crosses a workspace, or touches a rule, SOUL, an approval rule, a risk tier or egress.

import { createHash } from "node:crypto";
import {
  type BotId,
  DeskmatesError,
  MEMORY_BATCH_MAX,
  type MemoryBatchDecision,
  type MemoryBatchPreview,
  type MemoryReviewBatch,
  type MemoryReviewGroup,
  type ThreadId,
  type WorkspaceId,
  memoryReviewGroupKey,
} from "@deskmates/contracts";
import type { AuditLog } from "../audit/audit-log.js";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { StoredConfirmation } from "./confirmations.js";
import { type MemoryStores, applyConfirmation } from "./learned-writes.js";
import { forgetEntry, undoEntry } from "./versions.js";

/** A17: give rows gated before amendment 3 their group key. Cheap when there are none. */
export function backfillGroupKeys(db: GatewayDb, workspaceId: WorkspaceId): void {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, proposed_scope, bot_id, thread_id, trust, body
       FROM memory_suggestions WHERE workspace_id = ? AND group_key IS NULL`,
    )
    .all(workspaceId) as {
    id: string;
    workspace_id: string;
    proposed_scope: "task" | "workspace" | "bot";
    bot_id: string;
    thread_id: string | null;
    trust: "trusted" | "untrusted";
    body: string;
  }[];
  if (rows.length === 0) return;
  const update = db.prepare("UPDATE memory_suggestions SET group_key = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of rows)
      update.run(
        memoryReviewGroupKey({
          workspaceId: row.workspace_id,
          proposedScope: row.proposed_scope,
          botId: row.bot_id,
          ...(row.thread_id ? { threadId: row.thread_id } : {}),
          trust: row.trust,
          body: row.body,
        }),
        row.id,
      );
  })();
}

interface GroupRow {
  group_key: string;
  n: number;
  oldest: string;
  newest: string;
}

/** A page of pending groups, newest activity first (`newest DESC, group_key DESC`). */
export function listReviewGroups(
  stores: MemoryStores,
  workspaceId: WorkspaceId,
  page: { limit: number; after?: readonly [string, string] },
): { groups: MemoryReviewGroup[]; more: boolean; totalGroups: number; totalItems: number } {
  const db = stores.entries.db;
  backfillGroupKeys(db, workspaceId);
  const after = page.after;
  const rows = db
    .prepare(
      `SELECT group_key, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
       FROM memory_suggestions WHERE workspace_id = ? AND status = 'pending'
       GROUP BY group_key
       HAVING (? IS NULL OR MAX(created_at) < ? OR (MAX(created_at) = ? AND group_key < ?))
       ORDER BY newest DESC, group_key DESC LIMIT ?`,
    )
    .all(
      workspaceId,
      after?.[0] ?? null,
      after?.[0] ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      page.limit + 1,
    ) as GroupRow[];
  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT group_key) AS groups, COUNT(*) AS items FROM memory_suggestions
       WHERE workspace_id = ? AND status = 'pending'`,
    )
    .get(workspaceId) as { groups: number; items: number };
  return {
    groups: rows.slice(0, page.limit).map((row) => {
      const items = pendingItems(stores, workspaceId, row.group_key);
      const first = items[0] as StoredConfirmation;
      return {
        groupKey: row.group_key,
        workspaceId,
        proposedScope: first.proposedScope,
        trust: first.trust,
        ...(first.proposedScope === "bot" ? { botId: first.botId as BotId } : {}),
        ...(first.threadId ? { threadId: first.threadId as ThreadId } : {}),
        count: row.n,
        items,
        oldestAt: row.oldest,
        newestAt: row.newest,
      };
    }),
    more: rows.length > page.limit,
    totalGroups: totals.groups,
    totalItems: totals.items,
  };
}

/** The oldest pending items of a group, at most one batch. */
function pendingItems(
  stores: MemoryStores,
  workspaceId: WorkspaceId,
  groupKey: string,
): StoredConfirmation[] {
  const ids = stores.entries.db
    .prepare(
      `SELECT id FROM memory_suggestions
       WHERE workspace_id = ? AND status = 'pending' AND group_key = ?
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(workspaceId, groupKey, MEMORY_BATCH_MAX) as { id: string }[];
  return ids.map((row) => stores.confirmations.get(row.id));
}

function pendingCount(db: GatewayDb, workspaceId: WorkspaceId, groupKey: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_suggestions
         WHERE workspace_id = ? AND status = 'pending' AND group_key = ?`,
      )
      .get(workspaceId, groupKey) as { n: number }
  ).n;
}

function tokenOf(
  workspaceId: WorkspaceId,
  groupKey: string,
  decision: MemoryBatchDecision,
  items: readonly StoredConfirmation[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([workspaceId, groupKey, decision, items.map((i) => [i.id, i.status])]))
    .digest("base64url")
    .slice(0, 32);
}

function assertDecision(decision: unknown): asserts decision is MemoryBatchDecision {
  if (decision !== "reject" && decision !== "merge")
    throw new DeskmatesError("validation", "Expected reject or merge", { field: "decision" });
}

/** A18: what a batch would decide. It changes nothing. */
export function previewBatch(
  stores: MemoryStores,
  workspaceId: WorkspaceId,
  groupKey: string,
  decision: unknown,
): MemoryBatchPreview {
  assertDecision(decision);
  backfillGroupKeys(stores.entries.db, workspaceId);
  const items = pendingItems(stores, workspaceId, groupKey);
  if (items.length === 0)
    throw new DeskmatesError("not_found", "No pending items in this review group");
  const first = items[0] as StoredConfirmation;
  return {
    groupKey,
    decision,
    itemIds: items.map((item) => item.id),
    ...(decision === "merge" ? { representativeId: first.id } : {}),
    remaining: pendingCount(stores.entries.db, workspaceId, groupKey) - items.length,
    token: tokenOf(workspaceId, groupKey, decision, items),
  };
}

interface BatchRow {
  id: string;
  workspace_id: string;
  group_key: string;
  decision: MemoryBatchDecision;
  token: string;
  entry_id: string | null;
  created_entry: number;
  entry_version: number | null;
  decided_by: string;
  created_at: string;
  undone_by: string | null;
  undone_at: string | null;
}

function batchView(db: GatewayDb, row: BatchRow): MemoryReviewBatch {
  const items = db
    .prepare(
      "SELECT suggestion_id FROM memory_review_batch_items WHERE batch_id = ? ORDER BY position",
    )
    .all(row.id) as { suggestion_id: string }[];
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    groupKey: row.group_key,
    decision: row.decision,
    itemIds: items.map((item) => item.suggestion_id),
    ...(row.entry_id ? { entryId: row.entry_id } : {}),
    createdEntry: row.created_entry === 1,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    ...(row.undone_by ? { undoneBy: row.undone_by } : {}),
    ...(row.undone_at ? { undoneAt: row.undone_at } : {}),
  };
}

function batchRow(db: GatewayDb, workspaceId: WorkspaceId, id: string): BatchRow {
  const row = db
    .prepare("SELECT * FROM memory_review_batches WHERE workspace_id = ? AND id = ?")
    .get(workspaceId, id) as BatchRow | undefined;
  if (!row) throw new DeskmatesError("not_found", "Review batch not found");
  return row;
}

/** A18: decide the previewed items in one transaction; the same token returns the same batch. */
export function commitBatch(
  stores: MemoryStores,
  audit: AuditLog,
  input: {
    workspaceId: WorkspaceId;
    groupKey: string;
    decision: unknown;
    token: unknown;
    by: string;
  },
  now: Date = new Date(),
): MemoryReviewBatch {
  assertDecision(input.decision);
  const decision = input.decision;
  if (typeof input.token !== "string" || input.token === "")
    throw new DeskmatesError("validation", "Expected the preview token", { field: "token" });
  const token = input.token;
  const db = stores.entries.db;
  return db.transaction(() => {
    const earlier = db
      .prepare("SELECT * FROM memory_review_batches WHERE workspace_id = ? AND token = ?")
      .get(input.workspaceId, token) as BatchRow | undefined;
    if (earlier) return batchView(db, earlier);
    const preview = previewBatch(stores, input.workspaceId, input.groupKey, decision);
    if (preview.token !== token)
      throw new DeskmatesError(
        "invalid_transition",
        "This review group changed since the preview; preview it again",
      );
    const items = preview.itemIds.map((id) => stores.confirmations.get(id));
    const at = now.toISOString();
    let entryId: string | undefined;
    let createdEntry = false;
    let entryVersion: number | undefined;
    if (decision === "reject") {
      for (const item of items) stores.confirmations.reject(item.id, input.by);
    } else {
      const [representative, ...copies] = items as [StoredConfirmation, ...StoredConfirmation[]];
      const applied = applyConfirmation(stores, representative.id, input.by, now);
      entryId = applied.entry.id;
      createdEntry = applied.entry.derivedFrom.includes(representative.id);
      for (const copy of copies) {
        // A10: another source of the same note; it never changes the note's trust.
        stores.entries.addSource({
          workspaceId: input.workspaceId,
          entryId,
          sourceRunId: copy.runId,
          ordinal: copy.ordinal,
          sourceKind: copy.sourceKind,
          trust: copy.trust,
          effectiveAt: copy.createdAt,
          effectiveBasis: "ingest",
          recordedAt: at,
        });
        stores.confirmations.applied(copy.id, input.by, entryId);
      }
      entryVersion = stores.entries.mustGet(entryId).version;
    }
    const id = newId("mrb");
    db.prepare(
      `INSERT INTO memory_review_batches (id, workspace_id, group_key, decision, token, entry_id,
         created_entry, entry_version, decided_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.workspaceId,
      input.groupKey,
      decision,
      token,
      entryId ?? null,
      createdEntry ? 1 : 0,
      entryVersion ?? null,
      input.by,
      at,
    );
    const insertItem = db.prepare(
      "INSERT INTO memory_review_batch_items (batch_id, suggestion_id, position) VALUES (?,?,?)",
    );
    items.forEach((item, position) => insertItem.run(id, item.id, position));
    audit.record({
      action: "memory.review_batch",
      actor: input.by,
      workspaceId: input.workspaceId,
      targetKind: "memory_review_batch",
      targetId: id,
      after: { decision, items: items.length, ...(entryId ? { entryId } : {}) },
    });
    return batchView(db, batchRow(db, input.workspaceId, id));
  })();
}

/** A19: undo a batch as a whole, only while every item is as the batch left it. */
export function undoBatch(
  stores: MemoryStores,
  audit: AuditLog,
  input: { workspaceId: WorkspaceId; batchId: string; by: string },
  now: Date = new Date(),
): MemoryReviewBatch {
  const db = stores.entries.db;
  return db.transaction(() => {
    const row = batchRow(db, input.workspaceId, input.batchId);
    if (row.undone_at)
      throw new DeskmatesError("invalid_transition", "This review batch was already undone");
    const batch = batchView(db, row);
    const items = batch.itemIds.map((id) => stores.confirmations.get(id));
    const expected = batch.decision === "reject" ? "rejected" : "applied";
    if (items.some((item) => item.status !== expected || item.entryId !== batch.entryId))
      throw new DeskmatesError("invalid_transition", "An item of this batch changed since");
    if (batch.decision === "merge") {
      const entryId = batch.entryId as string;
      const entry = stores.entries.mustGetIn(input.workspaceId, entryId);
      if (!batch.createdEntry)
        throw new DeskmatesError(
          "invalid_transition",
          "This batch added sources to an existing note; change that note through its history",
        );
      if (entry.tombstoned || entry.version !== row.entry_version)
        throw new DeskmatesError("invalid_transition", "The merged note changed since");
      // A12: a note the merged one replaced becomes current again before the merged note goes.
      for (const receipt of stores.entries.supersessions(input.workspaceId, entryId)) {
        if (receipt.winnerId !== entryId || receipt.reason === "undo_restore") continue;
        const loser = stores.entries.get(receipt.entryId);
        if (loser && !loser.tombstoned && loser.invalidAt !== undefined)
          undoEntry(stores.entries, input.workspaceId, loser.id, input.by);
      }
      forgetEntry(stores.entries, input.workspaceId, entryId, input.by);
    }
    for (const item of items) stores.confirmations.reopen(item.id);
    db.prepare("UPDATE memory_review_batches SET undone_by = ?, undone_at = ? WHERE id = ?").run(
      input.by,
      now.toISOString(),
      row.id,
    );
    audit.record({
      action: "memory.review_batch_undo",
      actor: input.by,
      workspaceId: input.workspaceId,
      targetKind: "memory_review_batch",
      targetId: row.id,
      before: { decision: batch.decision, items: items.length },
    });
    return batchView(db, batchRow(db, input.workspaceId, row.id));
  })();
}

/** The batches of a workspace, newest first, for the undo list. */
export function recentBatches(
  db: GatewayDb,
  workspaceId: WorkspaceId,
  limit: number,
): MemoryReviewBatch[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_review_batches WHERE workspace_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as BatchRow[];
  return rows.map((row) => batchView(db, row));
}
