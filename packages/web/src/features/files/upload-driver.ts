// The browser half of a workspace upload (ADR-0014 amendment A5 decision 31): create a session,
// send the file's parts in sequence at the received length, then complete. A lost answer is
// resolved by reading the session back; a retry with the same idempotency key resumes the same
// session. Cancelling aborts the part in flight and deletes the session's partial file. Nothing
// here reads the whole file into memory: each part is a `Blob.slice` the browser streams.

import {
  WORKSPACE_FILE_UPLOAD_PART_BYTES,
  type WorkspaceId,
  type WorkspaceUpload,
} from "@deskmates/contracts";
import { ApiError } from "../../api/types.js";
import type { FilesApi } from "./api.js";

export type UploadApi = Pick<
  FilesApi,
  | "cancelWorkspaceUpload"
  | "completeWorkspaceUpload"
  | "createWorkspaceUpload"
  | "getWorkspaceUpload"
  | "sendWorkspaceUploadPart"
>;

/** Attempts per part after a transient failure (network, busy, unavailable workspace). */
export const UPLOAD_PART_RETRIES = 3;

export interface UploadOptions {
  /** Called after the session exists and after every acknowledged part. */
  onProgress?: (progress: { uploadId: string; sentBytes: number; totalBytes: number }) => void;
  signal?: AbortSignal;
  /** The same key resumes the same session; a new upload gets a new one. */
  idempotencyKey: string;
  /** Tests use small parts; the Gateway accepts at most WORKSPACE_FILE_UPLOAD_PART_BYTES. */
  partBytes?: number;
}

/** A new idempotency key for one file the person chose. */
export function newUploadKey(): string {
  return `web-${globalThis.crypto.randomUUID()}`;
}

/** The person cancelled; the session was deleted (or deleting it was attempted). */
export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelled";
  }
}

function transient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "network") return true;
  if (error.details.reason === "upload_busy") return true;
  return error.code === "sandbox_unavailable";
}

/** Waits between cancel attempts while the aborted part is still being written. */
export const UPLOAD_CANCEL_RETRY_MS = 300;

/**
 * Delete the session. An aborted request does not stop the Gateway's write in flight, which
 * answers `upload_busy` until it ends; ask again a few times. Expiry removes what remains.
 */
async function cancelSession(api: UploadApi, workspaceId: WorkspaceId, uploadId: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await api.cancelWorkspaceUpload(workspaceId, uploadId);
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.details.reason !== "upload_busy") return;
      await new Promise((resolve) => setTimeout(resolve, UPLOAD_CANCEL_RETRY_MS));
    }
  }
}

/** Upload one file into the workspace and answer the completed session with its final path. */
export async function uploadWorkspaceFile(
  api: UploadApi,
  workspaceId: WorkspaceId,
  file: Blob & { name: string },
  options: UploadOptions,
): Promise<WorkspaceUpload> {
  const { signal } = options;
  const partBytes = Math.min(
    options.partBytes ?? WORKSPACE_FILE_UPLOAD_PART_BYTES,
    WORKSPACE_FILE_UPLOAD_PART_BYTES,
  );
  if (signal?.aborted) throw new UploadCancelled();
  const session = await api.createWorkspaceUpload(workspaceId, {
    name: file.name,
    sizeBytes: file.size,
    idempotencyKey: options.idempotencyKey,
  });
  if (session.state === "completed") return session;
  const report = (sentBytes: number) =>
    options.onProgress?.({ uploadId: session.id, sentBytes, totalBytes: file.size });
  let received = session.receivedBytes;
  report(received);
  try {
    let failures = 0;
    while (received < file.size) {
      if (signal?.aborted) throw new UploadCancelled();
      const end = Math.min(file.size, received + partBytes);
      try {
        const next = await api.sendWorkspaceUploadPart(workspaceId, session.id, {
          offset: received,
          part: file.slice(received, end),
          ...(signal ? { signal } : {}),
        });
        received = next.receivedBytes;
        failures = 0;
        report(received);
        continue;
      } catch (error) {
        if (signal?.aborted) throw new UploadCancelled();
        // The Gateway names what it holds: resume from there.
        if (
          error instanceof ApiError &&
          error.details.reason === "upload_offset_mismatch" &&
          typeof error.details.receivedBytes === "number"
        ) {
          received = error.details.receivedBytes;
          report(received);
          continue;
        }
        if (!transient(error) || ++failures > UPLOAD_PART_RETRIES) throw error;
      }
      // A transient failure: the part may or may not have landed; ask before sending again.
      received = (await api.getWorkspaceUpload(workspaceId, session.id)).receivedBytes;
      report(received);
    }
    if (signal?.aborted) throw new UploadCancelled();
    return await api.completeWorkspaceUpload(workspaceId, session.id);
  } catch (error) {
    if (error instanceof UploadCancelled || signal?.aborted) {
      await cancelSession(api, workspaceId, session.id);
      throw new UploadCancelled();
    }
    throw error;
  }
}
