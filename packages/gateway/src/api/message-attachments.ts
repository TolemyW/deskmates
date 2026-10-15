// A person's message attachments (ADR-0014 amendment A5 decision 42). A human post names its own
// completed uploads by id; the Gateway resolves each one in the thread's workspace and stores the
// upload's label, a type from the extension, the final path, the id and the size. Nothing a
// client sends besides the id reaches the stored attachment.

import {
  type Attachment,
  DeskmatesError,
  MESSAGE_ATTACHMENTS_MAX,
  WORKSPACE_UPLOAD_ID,
  type WorkspaceId,
  uploadAttachmentMime,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { WorkspaceUploads } from "../files/workspace-uploads.js";

function notAttachable(uploadId: unknown): DeskmatesError {
  return new DeskmatesError("validation", "attachments must name your own completed uploads", {
    field: "attachments",
    reason: "attachment_not_attachable",
    ...(typeof uploadId === "string" ? { uploadId } : {}),
  });
}

/** The raw `attachments` of a human post as upload ids; repeated ids collapse to one. */
export function parseMessageUploadIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MESSAGE_ATTACHMENTS_MAX)
    throw new DeskmatesError(
      "validation",
      `attachments must be an array of at most ${MESSAGE_ATTACHMENTS_MAX} {uploadId}`,
      { field: "attachments" },
    );
  const ids: string[] = [];
  for (const item of raw) {
    const uploadId =
      typeof item === "object" && item !== null ? (item as { uploadId?: unknown }).uploadId : item;
    if (typeof uploadId !== "string" || !WORKSPACE_UPLOAD_ID.test(uploadId))
      throw notAttachable(uploadId);
    if (!ids.includes(uploadId)) ids.push(uploadId);
  }
  return ids;
}

/**
 * Resolve upload ids to stored attachments: each must be a completed, not deleted upload of this
 * workspace whose uploader is `poster` (the caller's actor label). Any other id refuses the post.
 */
export function resolveMessageAttachments(
  db: GatewayDb,
  workspaceId: WorkspaceId,
  poster: string,
  uploadIds: readonly string[],
): Attachment[] {
  const uploads = new WorkspaceUploads(db);
  return uploadIds.map((uploadId) => {
    const upload = uploads.get(workspaceId, uploadId);
    if (
      upload === undefined ||
      upload.uploader !== poster ||
      upload.state !== "completed" ||
      upload.path === undefined ||
      upload.deletedAt !== undefined
    )
      throw notAttachable(uploadId);
    return {
      name: upload.label,
      mimeType: uploadAttachmentMime(upload.path),
      ref: upload.path,
      uploadId: upload.id,
      sizeBytes: upload.sizeBytes,
    };
  });
}
