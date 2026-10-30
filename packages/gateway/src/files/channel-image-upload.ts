// An image a person sends through an ABI-2 channel enters the workspace exactly like a Web upload
// (ADR-0047 decision 12): an upload session in `workspace_uploads` whose uploader is the channel
// author id, the same container command writing the bytes under `/work/uploads/<date>/`, the same
// `file.upload` audit row and an attachment shaped like `resolveMessageAttachments` builds. The
// model sees it only through the run's vision policy (ADR-0023 amendment 2), as for a Web upload.

import {
  type Attachment,
  DeskmatesError,
  WORKSPACE_FILE_UPLOAD_PART_BYTES,
  type WorkspaceId,
  sanitizeUploadName,
  uploadAttachmentMime,
  uploadDateDir,
  uploadLabel,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { fileWrite, notRunning } from "./workspace-file-write.js";
import { WorkspaceUploads } from "./workspace-uploads.js";

export interface ChannelImageInput {
  workspaceId: WorkspaceId;
  /** The channel author id, `<channel>:<sender id>`. */
  uploader: string;
  name: string;
  bytes: Uint8Array;
  /** Stable per inbound message and image, so a redelivery reuses the stored upload. */
  idempotencyKey: string;
}

export type ChannelImageStore = (input: ChannelImageInput) => Promise<Attachment>;

function attachmentOf(upload: {
  id: string;
  label: string;
  path?: string;
  sizeBytes: number;
}): Attachment {
  const path = upload.path as string;
  return {
    name: upload.label,
    mimeType: uploadAttachmentMime(path),
    ref: path,
    uploadId: upload.id,
    sizeBytes: upload.sizeBytes,
  };
}

export function createChannelImageStore(
  ctx: GatewayContext,
  now: () => number = Date.now,
): ChannelImageStore {
  const uploads = new WorkspaceUploads(ctx.db);
  const abandon = async (workspaceId: WorkspaceId, uploadId: string): Promise<void> => {
    try {
      await fileWrite(ctx, workspaceId, { op: "abort", uploadId });
    } catch {
      // The partial file is the container's; the row is what a retry would trip over.
    }
    uploads.discard(workspaceId, uploadId);
  };
  return async (input) => {
    const existing = uploads.byIdempotencyKey(input.workspaceId, input.idempotencyKey);
    if (existing?.state === "completed" && existing.path !== undefined)
      return attachmentOf(existing);
    // A session an earlier delivery left unfinished is dropped and the image written again.
    if (existing?.state === "receiving") await abandon(input.workspaceId, existing.id);
    else if (existing)
      throw new DeskmatesError("invalid_transition", `The image upload is ${existing.state}`);
    const sizeBytes = input.bytes.byteLength;
    const quota = ctx.config.fileUploadWorkspaceQuotaBytes ?? 0;
    if (quota > 0 && uploads.reservedBytes(input.workspaceId) + sizeBytes > quota)
      throw new DeskmatesError(
        "payload_too_large",
        "The workspace upload quota would be exceeded",
        {
          reason: "workspace_upload_quota",
        },
      );
    if (!(await ctx.sandboxes.peek(input.workspaceId))) throw notRunning();
    const upload = uploads.create({
      workspaceId: input.workspaceId,
      uploader: input.uploader,
      name: sanitizeUploadName(input.name),
      label: uploadLabel(input.name),
      sizeBytes,
      idempotencyKey: input.idempotencyKey,
    });
    try {
      await fileWrite(ctx, input.workspaceId, { op: "begin", uploadId: upload.id });
      const bytes = Buffer.from(input.bytes);
      for (let offset = 0; offset < sizeBytes; offset += WORKSPACE_FILE_UPLOAD_PART_BYTES) {
        const part = bytes.subarray(offset, offset + WORKSPACE_FILE_UPLOAD_PART_BYTES);
        const appended = await fileWrite(ctx, input.workspaceId, {
          op: "append",
          uploadId: upload.id,
          offset,
          base64: part.toString("base64"),
        });
        uploads.setReceived(input.workspaceId, upload.id, appended.receivedBytes);
      }
      const written = await fileWrite(ctx, input.workspaceId, {
        op: "commit",
        uploadId: upload.id,
        sizeBytes,
        dir: uploadDateDir(new Date(now())),
        name: upload.name,
      });
      const completed = ctx.db.transaction(() => {
        const done = uploads.complete(input.workspaceId, upload.id, written);
        ctx.audit.record({
          action: "file.upload",
          actor: input.uploader,
          workspaceId: input.workspaceId,
          targetKind: "workspace_upload",
          targetId: upload.id,
          after: {
            path: written.path,
            sizeBytes: written.sizeBytes,
            sha256: written.sha256,
            label: upload.label,
          },
        });
        return done;
      })();
      return attachmentOf(completed);
    } catch (error) {
      await abandon(input.workspaceId, upload.id);
      throw error;
    }
  };
}
