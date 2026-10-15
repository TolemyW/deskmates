// The workspace Files collection (ADR-0014 amendments A2 and A4): verified formal Bot results,
// files a person supplied as input, and legacy delivered task artifacts, grouped by exact lexical
// path. SQL only, so listing never reaches the workspace container (decision 14); preview and
// download stay on the one-file route.
//
// Four sources (A4 decision 22, A5 decision 33): current publication records, workspace-path
// attachments on human-authored messages, completed workspace uploads, and artifact references on
// delivered or accepted tasks that have no publication for that path. Paths named or attached by bots in chat, checkpoints and artifacts of
// undelivered tasks are not sources; they stay links in their chat. Each source reads at most
// `scanLimit` of its newest references; hitting the cap marks the page `truncated` (decision 13).

import {
  type BotId,
  FILE_COLLECTION_ITEM_REFERENCES,
  FILE_COLLECTION_SCAN_LIMIT,
  type FileCollectionQuery,
  type FilePublication,
  type FileReference,
  type FileSource,
  type FileVerification,
  type IsoTimestamp,
  type MessageId,
  type RunId,
  type ThreadId,
  type WorkspaceFileCollectionPage,
  type WorkspaceFileItem,
  type WorkspaceId,
  fileKindOf,
  workspaceFileRoot,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

interface PublicationRow {
  id: string;
  task_id: string;
  task_title: string;
  task_deleted_at: string | null;
  delivery_kind: "complete" | "partial";
  path: string;
  label: string;
  size_bytes: number;
  sha256: string;
  check_kind: string;
  checked_at: string;
  published_at: string;
  run_id: string | null;
  bot_id: string | null;
  bot_name: string | null;
  superseded: number;
}

interface TaskArtifactRow {
  task_id: string;
  task_title: string;
  at: string;
  path: unknown;
  label: unknown;
  run_id: string | null;
  bot_id: string | null;
  bot_name: string | null;
}

interface AttachmentRow {
  message_id: string;
  thread_id: string;
  thread_title: string;
  ts: string;
  ref: unknown;
  name: unknown;
}

// The current (not superseded) publication of each task and path, newest first. The bot is
// joined only while its row exists in this workspace (decision 10).
const PUBLICATIONS_SQL = `
  SELECT p.id, p.task_id, t.title AS task_title, t.deleted_at AS task_deleted_at,
         d.kind AS delivery_kind, p.path, p.label, p.size_bytes, p.sha256, p.check_kind,
         p.checked_at, p.published_at, p.run_id, b.id AS bot_id, b.name AS bot_name,
         (SELECT count(*) FROM file_publications o
           WHERE o.task_id = p.task_id AND o.path = p.path AND o.superseded_at IS NOT NULL)
           AS superseded
    FROM file_publications p
    JOIN tasks t ON t.id = p.task_id
    JOIN task_deliveries d ON d.id = p.delivery_id
    LEFT JOIN bots b ON b.id = p.bot_id AND b.workspace_id = p.workspace_id
   WHERE p.workspace_id = ? AND p.superseded_at IS NULL
   ORDER BY p.published_at DESC, p.id
   LIMIT ?`;

// Legacy (A4 decision 26): an artifact reference on a delivered or accepted task with no
// publication for that path stays listed, honestly unverified, never backfilled.
const LEGACY_ARTIFACTS_SQL = `
  SELECT t.id AS task_id, t.title AS task_title,
         COALESCE(t.delivered_at, t.updated_at) AS at,
         a.path, a.label,
         r.id AS run_id, b.id AS bot_id, b.name AS bot_name
    FROM tasks t JOIN task_artifacts a ON a.task_id = t.id
    LEFT JOIN runs r ON r.id = a.run_id
    LEFT JOIN bots b ON b.id = r.bot_id AND b.workspace_id = t.workspace_id
   WHERE t.workspace_id = ? AND t.status IN ('delivered', 'accepted')
     AND NOT EXISTS (SELECT 1 FROM file_publications p WHERE p.task_id = t.id AND p.path = a.path)
   ORDER BY at DESC, t.id, a.ordinal
   LIMIT ?`;

// Inputs a person supplied: workspace-path attachments on human-authored messages.
const INPUT_ATTACHMENTS_SQL = `
  SELECT m.id AS message_id, m.thread_id, th.title AS thread_title, m.ts,
         json_extract(a.value, '$.ref') AS ref, json_extract(a.value, '$.name') AS name
    FROM thread_messages m JOIN threads th ON th.id = m.thread_id, json_each(m.attachments_json) a
   WHERE th.workspace_id = ? AND m.author_kind = 'human' AND m.attachments_json <> '[]'
     AND NOT EXISTS (SELECT 1 FROM workspace_uploads u
                      WHERE u.workspace_id = th.workspace_id
                        AND u.id = json_extract(a.value, '$.uploadId')
                        AND u.deleted_at IS NOT NULL)
   ORDER BY m.ts DESC, m.id
   LIMIT ?`;

interface UploadRow {
  id: string;
  path: string;
  label: string;
  uploader: string;
  size_bytes: number;
  sha256: string;
  completed_at: string;
}

// Inputs a person uploaded (A5 decision 33): completed sessions an Admin has not deleted
// (decision 43), newest first. A message attachment naming a deleted upload is dropped above.
const UPLOADS_SQL = `
  SELECT id, path, label, uploader, size_bytes, sha256, completed_at
    FROM workspace_uploads
   WHERE workspace_id = ? AND state = 'completed' AND deleted_at IS NULL
   ORDER BY completed_at DESC, id
   LIMIT ?`;

export interface FileCollectionOptions {
  /** Newest references read per source; tests lower it to exercise `truncated`. */
  scanLimit?: number;
}

interface Collected {
  path: string;
  refs: FileReference[];
  publication?: FilePublication;
  /** A legacy delivered artifact names this path. */
  legacy: boolean;
  /** A legacy reference ties the path to a bot run (decision 10). */
  legacyBot: boolean;
}

export class FileCollection {
  constructor(private readonly db: GatewayDb) {}

  list(
    workspaceId: WorkspaceId,
    query: FileCollectionQuery,
    options: FileCollectionOptions = {},
  ): WorkspaceFileCollectionPage {
    const limit = options.scanLimit ?? FILE_COLLECTION_SCAN_LIMIT;
    const botNames = (
      this.db.prepare("SELECT name FROM bots WHERE workspace_id = ?").all(workspaceId) as {
        name: string;
      }[]
    ).map((row) => row.name);
    const byPath = new Map<string, Collected>();
    const entry = (path: unknown): Collected | undefined => {
      // Decision 9: the lexical policy against this workspace's bots, before anything is kept.
      if (typeof path !== "string" || workspaceFileRoot(path, botNames) === undefined)
        return undefined;
      const found = byPath.get(path) ?? { path, refs: [], legacy: false, legacyBot: false };
      byPath.set(path, found);
      return found;
    };

    const publications = this.db
      .prepare(PUBLICATIONS_SQL)
      .all(workspaceId, limit) as PublicationRow[];
    for (const row of publications) {
      const target = entry(row.path);
      if (!target) continue;
      target.refs.push({
        kind: "publication",
        at: row.published_at as IsoTimestamp,
        taskId: row.task_id,
        taskTitle: row.task_title,
        label: row.label,
        usedInDelivery: true,
        ...(row.run_id ? { runId: row.run_id as RunId } : {}),
        ...(row.bot_id ? { botId: row.bot_id as BotId } : {}),
        ...(row.bot_name ? { botName: row.bot_name } : {}),
      });
      // Rows are newest first: the first one seen is the item's current publication.
      target.publication ??= {
        id: row.id,
        taskId: row.task_id,
        taskTitle: row.task_title,
        taskDeleted: row.task_deleted_at !== null,
        deliveryKind: row.delivery_kind,
        ...(row.run_id ? { runId: row.run_id as RunId } : {}),
        ...(row.bot_id ? { botId: row.bot_id as BotId } : {}),
        ...(row.bot_name ? { botName: row.bot_name } : {}),
        label: row.label,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        check: row.check_kind,
        checkedAt: row.checked_at as IsoTimestamp,
        publishedAt: row.published_at as IsoTimestamp,
        supersededCount: row.superseded,
      };
    }

    const legacy = this.db
      .prepare(LEGACY_ARTIFACTS_SQL)
      .all(workspaceId, limit) as TaskArtifactRow[];
    for (const row of legacy) {
      const target = entry(row.path);
      if (!target) continue;
      target.legacy = true;
      target.legacyBot ||= row.run_id !== null;
      target.refs.push({
        kind: "task_artifact",
        at: row.at as IsoTimestamp,
        taskId: row.task_id,
        taskTitle: row.task_title,
        usedInDelivery: true,
        ...(typeof row.label === "string" && row.label !== "" ? { label: row.label } : {}),
        ...(row.run_id ? { runId: row.run_id as RunId } : {}),
        ...(row.bot_id ? { botId: row.bot_id as BotId } : {}),
        ...(row.bot_name ? { botName: row.bot_name } : {}),
      });
    }

    const inputs = this.db
      .prepare(INPUT_ATTACHMENTS_SQL)
      .all(workspaceId, limit) as AttachmentRow[];
    for (const row of inputs) {
      const target = entry(row.ref);
      if (!target) continue;
      target.refs.push({
        kind: "message_attachment",
        at: row.ts as IsoTimestamp,
        threadId: row.thread_id as ThreadId,
        threadTitle: row.thread_title,
        messageId: row.message_id as MessageId,
        authorKind: "human",
        ...(typeof row.name === "string" && row.name !== "" ? { label: row.name } : {}),
      });
    }

    const uploaded = this.db.prepare(UPLOADS_SQL).all(workspaceId, limit) as UploadRow[];
    for (const row of uploaded) {
      const target = entry(row.path);
      if (!target) continue;
      target.refs.push({
        kind: "upload",
        at: row.completed_at as IsoTimestamp,
        label: row.label,
        uploadId: row.id,
        uploader: row.uploader,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
      });
    }

    const truncated = [publications, legacy, inputs, uploaded].some((rows) => rows.length >= limit);
    const entries = [...byPath.values()];
    const types = {
      documents: 0,
      images: 0,
      web: 0,
      other: 0,
    } satisfies WorkspaceFileCollectionPage["facets"]["types"];
    const sources = {
      bot: 0,
      uploaded: 0,
      unknown: 0,
    } satisfies WorkspaceFileCollectionPage["facets"]["sources"];
    for (const item of entries) {
      if (matchesSearch(item, query.q) && matchesSource(item, query.source))
        types[fileKindOf(item.path)] += 1;
      if (matchesSearch(item, query.q) && matchesType(item, query.type))
        sources[sourceOf(item)] += 1;
    }
    const matches = entries
      .filter((item) => matchesQuery(item, query))
      .map(toItem)
      .sort(
        (a, b) =>
          b.lastReferencedAt.localeCompare(a.lastReferencedAt) || a.path.localeCompare(b.path),
      );
    return {
      scope: "published-results-and-inputs",
      items: matches.slice(query.offset, query.offset + query.limit),
      total: matches.length,
      offset: query.offset,
      limit: query.limit,
      truncated,
      facets: { types, sources },
    };
  }
}

function toItem(entry: Collected): WorkspaceFileItem {
  const refs = [...entry.refs].sort((a, b) => b.at.localeCompare(a.at));
  return {
    path: entry.path,
    name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
    kind: fileKindOf(entry.path),
    source: sourceOf(entry),
    verification: verificationOf(entry),
    ...(entry.publication ? { publication: entry.publication } : {}),
    lastReferencedAt: (refs[0] as FileReference).at,
    referenceCount: refs.length,
    references: refs.slice(0, FILE_COLLECTION_ITEM_REFERENCES),
  };
}

/** A4 decision 26: a publication wins, then a legacy delivery, else the file is an input. */
function verificationOf(entry: Collected): FileVerification {
  if (entry.publication) return "verified";
  return entry.legacy ? "unverified" : "input";
}

function sourceOf(entry: Collected): FileSource {
  if (entry.publication || entry.legacyBot) return "bot";
  return entry.legacy ? "unknown" : "uploaded";
}

/** Type, source and search over every reference of the path, not only the ones returned. */
function matchesQuery(entry: Collected, query: FileCollectionQuery): boolean {
  return (
    matchesType(entry, query.type) &&
    matchesSource(entry, query.source) &&
    matchesSearch(entry, query.q)
  );
}

const matchesType = (entry: Collected, type: FileCollectionQuery["type"]): boolean =>
  type === "all" || fileKindOf(entry.path) === type;

const matchesSource = (entry: Collected, source: FileCollectionQuery["source"]): boolean =>
  source === "all" || sourceOf(entry) === source;

function matchesSearch(entry: Collected, q: string): boolean {
  if (q === "" || entry.path.toLowerCase().includes(q)) return true;
  return entry.refs.some((ref) => ref.label?.toLowerCase().includes(q) ?? false);
}
