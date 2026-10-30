// The workspace Files collection (ADR-0014 amendment A2). A read-only list of workspace paths the
// Gateway already holds as references: task artifacts, message attachments and paths named in
// bot-authored messages. It is not a filesystem inventory, and building it never touches the
// workspace container. Preview and download keep using the one-file route of decisions 1 to 7.

import type { BotId, IsoTimestamp, MessageId, RunId, ThreadId } from "./ids.js";

/** Items per page when the client names no `limit` (decision 13). */
export const FILE_COLLECTION_PAGE_SIZE = 25;
/** The largest `limit` the route accepts. */
export const FILE_COLLECTION_MAX_PAGE_SIZE = 100;
/** Most recent references of each kind one listing reads; beyond it the page says `truncated`. */
export const FILE_COLLECTION_SCAN_LIMIT = 10_000;
/** References carried per item; `referenceCount` is the full number. */
export const FILE_COLLECTION_ITEM_REFERENCES = 20;
/** Longest search string. */
export const FILE_COLLECTION_QUERY_MAX = 200;

/**
 * What the collection covers; named in every response so no client implies a full inventory.
 * ADR-0014 amendment A4: verified formal results, human-supplied inputs and legacy deliveries.
 */
export type FileCollectionScope = "published-results-and-inputs";

/**
 * A4 decision 26. `verified`: a publication record checked by the server. `unverified`: a legacy
 * delivered task artifact, never backfilled. `input`: a file a person attached to a message.
 */
export const FILE_VERIFICATIONS = ["verified", "unverified", "input"] as const;
export type FileVerification = (typeof FILE_VERIFICATIONS)[number];

/** The current publication of a verified item (A4 decision 24). */
export interface FilePublication {
  id: string;
  taskId: string;
  taskTitle: string;
  /** The task was deleted after publishing; the publication is kept (ADR-0021 A3e). */
  taskDeleted: boolean;
  deliveryKind: "complete" | "partial";
  runId?: RunId;
  botId?: BotId;
  botName?: string;
  label: string;
  sizeBytes: number;
  sha256: string;
  /** The server check that produced the digest. */
  check: string;
  checkedAt: IsoTimestamp;
  publishedAt: IsoTimestamp;
  /** Earlier publications of this task and path with another digest. */
  supersededCount: number;
}

export const FILE_KINDS = ["documents", "images", "web", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export type FileKindFilter = "all" | FileKind;

/**
 * Who the references tie a file to (decision 10). `bot`: at least one reference comes from a bot
 * run. `uploaded`: a person supplied the file as input, through a message attachment (A4 decision
 * 22) or an upload (A5 decision 33). `unknown`: neither.
 */
export const FILE_SOURCES = ["bot", "uploaded", "unknown"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];
export type FileSourceFilter = "all" | "bot" | "uploaded";

/**
 * Where a reference was recorded. `message_path` is no longer listed (A4 decision 22); `upload`
 * is a completed workspace upload (A5 decision 33).
 */
export type FileReferenceKind =
  | "publication"
  | "task_artifact"
  | "message_attachment"
  | "message_path"
  | "upload";

/**
 * One recorded reference. Absent ids mean the Gateway does not know them, or the linked row no
 * longer exists; a client shows them as unknown, never guesses.
 */
export interface FileReference {
  kind: FileReferenceKind;
  /** When the Gateway recorded it: message time, or the task's delivery or update time. */
  at: IsoTimestamp;
  threadId?: ThreadId;
  threadTitle?: string;
  messageId?: MessageId;
  /** `human` or `bot` for message references. */
  authorKind?: "human" | "bot";
  runId?: RunId;
  botId?: BotId;
  botName?: string;
  taskId?: string;
  taskTitle?: string;
  /** The task artifact label or the attachment name. */
  label?: string;
  /** This task reference is part of a delivered or accepted task (decision 11); never "accepted". */
  usedInDelivery?: true;
  /** `upload` references: the session, its uploader's actor label, size and in-container digest. */
  uploadId?: string;
  uploader?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface WorkspaceFileItem {
  /** The identity: the exact lexical path (decision 9). */
  path: string;
  /** The last path segment. */
  name: string;
  kind: FileKind;
  source: FileSource;
  verification: FileVerification;
  /** Only on `verified` items. */
  publication?: FilePublication;
  /** Newest reference time; not the file's modification time (decision 12). */
  lastReferencedAt: IsoTimestamp;
  referenceCount: number;
  /** Newest first, at most FILE_COLLECTION_ITEM_REFERENCES. */
  references: FileReference[];
  /**
   * The newest chat message the caller may read whose attachments name this path (ADR-0014
   * amendment A7): a person's input or a bot's delivery. Absent when no such message is visible;
   * another person's private chat is never named.
   */
  sentInChat?: FileChatDelivery;
}

/** Where a file was sent in chat: the message a "Sent in chat" link opens. */
export interface FileChatDelivery {
  threadId: ThreadId;
  threadTitle: string;
  messageId: MessageId;
  authorKind: "human" | "bot";
  at: IsoTimestamp;
}

/** `GET /api/workspaces/:id/assets`. */
export interface WorkspaceFileCollectionPage {
  scope: FileCollectionScope;
  items: WorkspaceFileItem[];
  /** Items matching the filters, across all pages. */
  total: number;
  offset: number;
  limit: number;
  /** At least one reference kind hit FILE_COLLECTION_SCAN_LIMIT; older references were not read. */
  truncated: boolean;
  /** Server-computed faceted counts (A3 decision 16), never counts of only this page. */
  facets: {
    /** Applies search and source, but deliberately ignores the selected type. */
    types: Record<FileKind, number>;
    /** Applies search and type, but deliberately ignores the selected source. */
    sources: Record<FileSource, number>;
  };
}

export interface FileCollectionQuery {
  offset: number;
  limit: number;
  type: FileKindFilter;
  source: FileSourceFilter;
  /** Lower-cased and trimmed; empty matches everything. */
  q: string;
}

const KIND_BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  md: "documents",
  markdown: "documents",
  txt: "documents",
  log: "documents",
  csv: "documents",
  tsv: "documents",
  json: "documents",
  jsonl: "documents",
  yaml: "documents",
  yml: "documents",
  xml: "documents",
  pdf: "documents",
  doc: "documents",
  docx: "documents",
  odt: "documents",
  rtf: "documents",
  xls: "documents",
  xlsx: "documents",
  ods: "documents",
  ppt: "documents",
  pptx: "documents",
  odp: "documents",
  png: "images",
  jpg: "images",
  jpeg: "images",
  gif: "images",
  webp: "images",
  bmp: "images",
  svg: "images",
  ico: "images",
  avif: "images",
  html: "web",
  htm: "web",
  xhtml: "web",
  mhtml: "web",
};

/** The type filter a path falls under, from its extension only (decision 13). */
export function fileKindOf(path: string): FileKind {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "other";
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "other";
}

const TOKEN = /(?<![A-Za-z0-9._\-/])\/(?:work|home)\/[A-Za-z0-9._\-/]*/g;

function linkable(path: string): boolean {
  const segments = path.split("/").slice(1);
  const minimum = segments[0] === "home" ? 3 : 2;
  return (
    segments.length >= minimum &&
    !path.endsWith("/") &&
    !segments.some((segment) => segment === "" || segment === "..")
  );
}

/**
 * Workspace paths in a message body, by ADR-0014 decision 5's token rule (the same paths the chat
 * turns into download links). Which bot homes exist is checked separately by `workspaceFileRoot`.
 */
export function workspacePathTokens(body: string): string[] {
  const paths: string[] = [];
  for (const match of body.matchAll(TOKEN)) {
    const start = match.index;
    // An unsupported Unicode filename is one path, never its linkable ASCII prefix.
    if (/^[\p{L}\p{N}\p{M}]/u.test(body.slice(start + match[0].length))) continue;
    const quote = body[start - 1];
    if (quote === '"' || quote === "'" || quote === "`") {
      const close = body.indexOf(quote, start);
      if (close > start && /\s/.test(body.slice(start, close))) continue;
    }
    const path = match[0].replace(/\.+$/, "");
    if (linkable(path)) paths.push(path);
  }
  return paths;
}

const KIND_FILTERS: readonly string[] = ["all", ...FILE_KINDS];
const SOURCE_FILTERS: readonly string[] = ["all", "bot", "uploaded"];

function nonNegativeInt(value: string): number | undefined {
  return /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** Validate the listing's query string; every refusal names the field. */
export function parseFileCollectionQuery(
  raw: Record<string, unknown>,
): { ok: true; query: FileCollectionQuery } | { ok: false; field: string } {
  const text = (field: string): string | undefined | null => {
    const value = raw[field];
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : null;
  };
  const offsetRaw = text("offset");
  const limitRaw = text("limit");
  const typeRaw = text("type");
  const sourceRaw = text("source");
  const qRaw = text("q");
  const offset =
    offsetRaw === undefined ? 0 : offsetRaw === null ? undefined : nonNegativeInt(offsetRaw);
  if (offset === undefined) return { ok: false, field: "offset" };
  const limit =
    limitRaw === undefined
      ? FILE_COLLECTION_PAGE_SIZE
      : limitRaw === null
        ? undefined
        : nonNegativeInt(limitRaw);
  if (limit === undefined || limit < 1 || limit > FILE_COLLECTION_MAX_PAGE_SIZE)
    return { ok: false, field: "limit" };
  const type = typeRaw ?? "all";
  if (type === null || !KIND_FILTERS.includes(type)) return { ok: false, field: "type" };
  const source = sourceRaw ?? "all";
  if (source === null || !SOURCE_FILTERS.includes(source)) return { ok: false, field: "source" };
  if (qRaw === null || (qRaw !== undefined && qRaw.length > FILE_COLLECTION_QUERY_MAX))
    return { ok: false, field: "q" };
  return {
    ok: true,
    query: {
      offset,
      limit,
      type: type as FileKindFilter,
      source: source as FileSourceFilter,
      q: (qRaw ?? "").trim().toLowerCase(),
    },
  };
}
