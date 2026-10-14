// Authenticated workspace uploads (ADR-0014 amendment A5). A person streams a file into
// `/work/uploads/<date>/` as a session of bounded parts; the Gateway never holds more than one
// part and stores no file bytes. The fixed container command `deskmates-sidecar file-write` applies
// the path and symlink policy; its request travels on stdin, never in argv or a shell.

import type { IsoTimestamp, WorkspaceId } from "./ids.js";

/**
 * Largest part one request carries and one container write takes (decision 30). A transport
 * unit, not a file cap: a reverse proxy in front of the Gateway must accept a body this large.
 */
export const WORKSPACE_FILE_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
/** Where every upload lands; the client never chooses a directory (decision 29). */
export const WORKSPACE_UPLOAD_ROOT = "/work/uploads";
/** The directory of partial files under the upload root. */
export const WORKSPACE_UPLOAD_PARTIAL_DIR = ".partial";
/** A receiving session with no activity for this long expires (decision 31). */
export const WORKSPACE_UPLOAD_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest sanitized file name, extension included. */
export const WORKSPACE_UPLOAD_NAME_MAX = 120;
/** Longest extension kept when a long name is shortened. */
export const WORKSPACE_UPLOAD_EXTENSION_MAX = 16;
/** Longest provenance label (the person's original name). */
export const WORKSPACE_UPLOAD_LABEL_MAX = 255;
/** Longest client idempotency key. */
export const WORKSPACE_UPLOAD_IDEMPOTENCY_KEY_MAX = 200;

/** Upload ids: `upl_` and 32 hex characters, the Gateway's id shape. */
export const WORKSPACE_UPLOAD_ID = /^upl_[a-f0-9]{32}$/;
/** The date directory under the upload root. */
export const WORKSPACE_UPLOAD_DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
/** A sanitized name: decision 2's characters, no leading `.`, `_` or `-`. */
export const WORKSPACE_UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const WORKSPACE_UPLOAD_STATES = ["receiving", "completed", "cancelled", "expired"] as const;
export type WorkspaceUploadState = (typeof WORKSPACE_UPLOAD_STATES)[number];

/** One upload session as the operator API returns it. */
export interface WorkspaceUpload {
  id: string;
  workspaceId: WorkspaceId;
  state: WorkspaceUploadState;
  /** The sanitized file name the final path will use, before any collision suffix. */
  name: string;
  /** The person's original name; provenance only, never part of a path. */
  label: string;
  sizeBytes: number;
  receivedBytes: number;
  /** The uploader's actor label (`user:<id>`, `service:<id>`, `human:web`). */
  uploader: string;
  /** Final workspace path once completed. */
  path?: string;
  /** SHA-256 computed inside the container over the committed file. */
  sha256?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
}

/** `POST /api/workspaces/:id/uploads`. */
export interface CreateWorkspaceUploadRequest {
  name: string;
  sizeBytes: number;
  idempotencyKey?: string;
}

/**
 * Decision 29: the safe file name of an upload. The last segment after `/` or `\`, every run of
 * characters outside `[A-Za-z0-9._-]` replaced by `_`, leading `.`, `_` and `-` stripped, at most
 * WORKSPACE_UPLOAD_NAME_MAX characters with a short extension kept, `upload` when nothing is left.
 */
export function sanitizeUploadName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? "";
  const extension =
    new RegExp(`\\.[A-Za-z0-9]{1,${WORKSPACE_UPLOAD_EXTENSION_MAX}}$`).exec(last)?.[0] ?? "";
  const trim = (value: string) => value.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  let stem = trim(last.slice(0, last.length - extension.length).replace(/[^A-Za-z0-9._-]+/g, "_"));
  stem = trim(stem.slice(0, WORKSPACE_UPLOAD_NAME_MAX - extension.length));
  // A stem with no letter or digit left (a name in another script, only dots) says nothing.
  if (!/[A-Za-z0-9]/.test(stem)) stem = "upload";
  return `${stem}${extension}`;
}

/** The person's original name as a provenance label: no control characters, bounded. */
export function uploadLabel(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.slice(0, WORKSPACE_UPLOAD_LABEL_MAX) || "upload";
}

/** The UTC date directory an upload completed on. */
export function uploadDateDir(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** stdin of `deskmates-sidecar file-write`; every operation names one upload id. */
export type WorkspaceFileWriteRequest =
  | { op: "begin"; uploadId: string }
  | { op: "append"; uploadId: string; offset: number; base64: string }
  | { op: "commit"; uploadId: string; sizeBytes: number; dir: string; name: string }
  | { op: "abort"; uploadId: string };

/** stdout of `file-write` on exit 0. */
export type WorkspaceFileWriteResult =
  | { op: "begin"; receivedBytes: 0 }
  | { op: "append"; receivedBytes: number }
  | { op: "commit"; path: string; sizeBytes: number; sha256: string }
  | { op: "abort"; removed: boolean };

export type WorkspaceFileWriteErrorCode =
  | "validation"
  | "forbidden"
  | "not_found"
  | "offset_mismatch"
  | "size_mismatch"
  | "storage_exhausted";

/** stdout of `file-write` on a non-zero exit. */
export interface WorkspaceFileWriteFailure {
  error: WorkspaceFileWriteErrorCode | "internal";
  message: string;
  /** The partial file's length, for `offset_mismatch` and `size_mismatch`. */
  receivedBytes?: number;
}
