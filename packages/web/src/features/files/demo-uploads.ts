// Demo upload sessions (ADR-0014 amendment A5). The demo has no workspace and keeps no bytes: a
// part only advances the received count, and a completed upload is listed in Files with a
// placeholder digest and a text stand-in for its download.

import {
  type FileReference,
  WORKSPACE_FILE_UPLOAD_PART_BYTES,
  type WorkspaceId,
  type WorkspaceUpload,
  sanitizeUploadName,
  uploadAttachmentMime,
  uploadDateDir,
  uploadLabel,
} from "@deskmates/contracts";
import type { DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const sessions = new Map<string, WorkspaceUpload>();
let counter = 0;

function invalid(reason: string, details: Record<string, unknown> = {}): Result {
  return {
    status: 409,
    json: {
      code: "invalid_transition",
      message: `Demo: ${reason}`,
      details: { reason, ...details },
    },
  };
}

/** Answers the upload routes; undefined for any other request. */
export function uploadRoute(req: DemoRequest, s: DemoState): Result | undefined {
  const base = req.match(/^\/api\/workspaces\/([^/]+)\/uploads$/);
  if (base && req.method === "POST") {
    const workspaceId = base[1] as WorkspaceId;
    const name = String(req.body.name ?? "");
    const sizeBytes = Number(req.body.sizeBytes ?? 0);
    const key = typeof req.body.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
    const existing = [...sessions.values()].find(
      (u) => u.workspaceId === workspaceId && key !== undefined && u.id.endsWith(`:${key}`),
    );
    if (existing) return ok(existing);
    counter += 1;
    const at = new Date().toISOString();
    const upload: WorkspaceUpload = {
      id: `upl_demo_${counter}${key === undefined ? "" : `:${key}`}`,
      workspaceId,
      state: "receiving",
      name: sanitizeUploadName(name),
      label: uploadLabel(name),
      sizeBytes,
      receivedBytes: 0,
      uploader: "human:web",
      createdAt: at,
      updatedAt: at,
    };
    sessions.set(upload.id, upload);
    return created(upload);
  }
  const one = req.match(
    /^\/api\/workspaces\/([^/]+)\/uploads\/([^/]+)(\/parts|\/complete|\/file)?$/,
  );
  if (!one) return undefined;
  const upload = sessions.get(decodeURIComponent(one[2] as string));
  if (!upload || upload.workspaceId !== one[1]) return notFound("Upload");
  const action = one[3];
  if (action === undefined && req.method === "GET") return ok(upload);
  if (action === undefined && req.method === "DELETE") {
    if (upload.state === "completed") return invalid("upload_completed");
    upload.state = "cancelled";
    return ok(upload);
  }
  if (action === "/parts" && req.method === "PUT") {
    if (upload.state !== "receiving") return invalid(`upload_${upload.state}`);
    const offset = Number(req.query.get("offset"));
    if (offset !== upload.receivedBytes)
      return invalid("upload_offset_mismatch", { receivedBytes: upload.receivedBytes });
    // The demo cannot see the part's bytes; the browser sends full parts but the last one.
    upload.receivedBytes = Math.min(upload.sizeBytes, offset + WORKSPACE_FILE_UPLOAD_PART_BYTES);
    return ok(upload);
  }
  if (action === "/file" && req.method === "DELETE") {
    if (upload.deletedAt) return invalid("upload_deleted");
    if (upload.state !== "completed" || !upload.path) return invalid(`upload_${upload.state}`);
    const at = new Date().toISOString();
    upload.deletedAt = at;
    upload.deletedBy = "human:web";
    upload.updatedAt = at;
    const removed = s.files.delete(upload.path);
    return ok({ upload, removed });
  }
  if (action === "/complete" && req.method === "POST") {
    if (upload.state === "completed") return ok(upload);
    if (upload.receivedBytes !== upload.sizeBytes) return invalid("upload_incomplete");
    const at = new Date().toISOString();
    upload.state = "completed";
    upload.path = `/work/uploads/${uploadDateDir(new Date())}/${upload.name}`;
    upload.sha256 = "0".repeat(64);
    upload.completedAt = at;
    upload.updatedAt = at;
    s.files.set(upload.path, "This demo keeps no uploaded bytes.");
    return ok(upload);
  }
  return undefined;
}

/** Completed demo uploads of a workspace as Files references. */
export function demoUploadReferences(
  workspaceId: WorkspaceId,
): Array<{ path: string; ref: FileReference }> {
  return [...sessions.values()]
    .filter(
      (u) => u.workspaceId === workspaceId && u.state === "completed" && u.path && !u.deletedAt,
    )
    .map((u) => ({
      path: u.path as string,
      ref: {
        kind: "upload",
        at: u.completedAt ?? u.updatedAt,
        label: u.label,
        uploadId: u.id,
        uploader: u.uploader,
        sizeBytes: u.sizeBytes,
        ...(u.sha256 ? { sha256: u.sha256 } : {}),
      },
    }));
}

/**
 * A demo message attachment for the person's own completed upload (ADR-0014 A5 decision 42);
 * undefined for an unknown, unfinished or deleted one.
 */
export function demoUploadAttachment(workspaceId: WorkspaceId, uploadId: string) {
  const upload = sessions.get(uploadId);
  if (
    !upload ||
    upload.workspaceId !== workspaceId ||
    upload.state !== "completed" ||
    !upload.path ||
    upload.deletedAt
  )
    return undefined;
  return {
    name: upload.label,
    mimeType: uploadAttachmentMime(upload.path),
    ref: upload.path,
    uploadId: upload.id,
    sizeBytes: upload.sizeBytes,
  };
}
