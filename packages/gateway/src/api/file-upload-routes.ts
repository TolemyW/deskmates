// ADR-0014 amendment A5: authenticated workspace uploads as sessions of bounded parts. The
// Gateway holds at most one part per request, writes it through the fixed container command
// `deskmates-sidecar file-write` with the request on stdin, and records only metadata. An upload
// starts no run, posts no message and touches no Knowledge, memory or task (decision 34).

import {
  DeskmatesError,
  WORKSPACE_FILE_UPLOAD_PART_BYTES,
  WORKSPACE_UPLOAD_IDEMPOTENCY_KEY_MAX,
  WORKSPACE_UPLOAD_IDLE_TTL_MS,
  type WorkspaceFileWriteFailure,
  type WorkspaceFileWriteRequest,
  type WorkspaceFileWriteResult,
  type WorkspaceId,
  type WorkspaceUpload,
  isDeskmatesError,
  sanitizeUploadName,
  uploadDateDir,
  uploadLabel,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { WorkspaceUploads } from "../files/workspace-uploads.js";
import { asRecord } from "./validate.js";
import { actsBelowAdmin } from "./workspace-access.js";

type UploadParams = { Params: { id: string; uploadId: string } };

export type FileUploadLog = (msg: string, data: Record<string, unknown>) => void;

export interface FileUploadRouteOptions {
  log?: FileUploadLog;
  /** Tests inject a clock to prove idle expiry without waiting a day. */
  now?: () => number;
}

/** A part of up to 4 MiB is about 5.6 MB of base64 on stdin; leave room for a slow disk. */
const EXEC_TIMEOUT_MS = 60_000;
/** Longest raw file name accepted before sanitizing. */
const RAW_NAME_MAX = 1024;
const PRINTABLE = /^[\x21-\x7e]+$/;
const POLICY_MESSAGE = "Uploads are written only into real directories under /work/uploads/";

function notRunning(): DeskmatesError {
  return new DeskmatesError("not_found", "Workspace is not running; nothing was written", {
    reason: "workspace_not_running",
  });
}

function unavailable(message: string): DeskmatesError {
  return new DeskmatesError("sandbox_unavailable", message);
}

function refusal(failure: WorkspaceFileWriteFailure): DeskmatesError {
  switch (failure.error) {
    case "forbidden":
      return new DeskmatesError("forbidden", POLICY_MESSAGE, { reason: "upload_path_policy" });
    case "validation":
      return new DeskmatesError("validation", "The workspace rejected the upload request");
    case "not_found":
      return new DeskmatesError(
        "not_found",
        "The upload's partial file is gone from the workspace",
        {
          reason: "upload_partial_missing",
        },
      );
    case "offset_mismatch":
      return new DeskmatesError(
        "invalid_transition",
        "The part does not start at the received length",
        {
          reason: "upload_offset_mismatch",
          receivedBytes: failure.receivedBytes,
        },
      );
    case "size_mismatch":
      return new DeskmatesError(
        "invalid_transition",
        "The upload has not received its declared size",
        {
          reason: "upload_incomplete",
          receivedBytes: failure.receivedBytes,
        },
      );
    case "storage_exhausted":
      return new DeskmatesError(
        "storage_exhausted",
        "The workspace has no space left for this upload",
        {
          reason: "storage_exhausted",
          ...(failure.receivedBytes === undefined ? {} : { receivedBytes: failure.receivedBytes }),
        },
      );
    default:
      return unavailable("File write failed inside the workspace");
  }
}

/** Run one `file-write` operation on the cached handle; a stopped workspace is never started. */
async function fileWrite<T extends WorkspaceFileWriteResult["op"]>(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  request: Extract<WorkspaceFileWriteRequest, { op: T }>,
): Promise<Extract<WorkspaceFileWriteResult, { op: T }>> {
  const handle = await ctx.sandboxes.peek(workspaceId);
  if (!handle) throw notRunning();
  let result: Awaited<ReturnType<GatewayContext["provider"]["exec"]>>;
  try {
    result = await ctx.provider.exec(handle, {
      cmd: ["deskmates-sidecar", "file-write"],
      stdin: JSON.stringify(request),
      timeoutMs: EXEC_TIMEOUT_MS,
    });
  } catch (error) {
    if (isDeskmatesError(error) && error.code === "sandbox_unavailable") throw error;
    throw unavailable("File write could not run in the workspace");
  }
  if (result.timedOut) throw unavailable("File write timed out");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    throw unavailable("File write returned an invalid response");
  }
  if (typeof value !== "object" || value === null)
    throw unavailable("File write returned an invalid response");
  if (result.exitCode !== 0) {
    throw refusal({
      error: (typeof value.error === "string"
        ? value.error
        : "internal") as WorkspaceFileWriteFailure["error"],
      message: "",
      ...(typeof value.receivedBytes === "number" ? { receivedBytes: value.receivedBytes } : {}),
    });
  }
  if (value.op !== request.op) throw unavailable("File write returned an invalid response");
  return value as Extract<WorkspaceFileWriteResult, { op: T }>;
}

function parseCreate(body: unknown): { name: string; sizeBytes: number; key?: string } {
  const record = asRecord(body);
  const { name, sizeBytes, idempotencyKey } = record;
  if (typeof name !== "string" || name.trim() === "" || name.length > RAW_NAME_MAX)
    throw new DeskmatesError("validation", "name must be a file name of 1 to 1024 characters", {
      field: "name",
    });
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw new DeskmatesError("validation", "sizeBytes must be a whole number of bytes", {
      field: "sizeBytes",
    });
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" ||
      idempotencyKey.length > WORKSPACE_UPLOAD_IDEMPOTENCY_KEY_MAX ||
      !PRINTABLE.test(idempotencyKey))
  )
    throw new DeskmatesError("validation", "idempotencyKey must be 1 to 200 printable characters", {
      field: "idempotencyKey",
    });
  return { name, sizeBytes, ...(idempotencyKey === undefined ? {} : { key: idempotencyKey }) };
}

function parseOffset(raw: unknown): number {
  const offset = typeof raw === "string" && /^\d{1,16}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(offset))
    throw new DeskmatesError("validation", "Expected ?offset=<received bytes>", {
      field: "offset",
    });
  return offset;
}

function stateRefusal(upload: WorkspaceUpload): DeskmatesError {
  return new DeskmatesError("invalid_transition", `The upload is ${upload.state}`, {
    reason: `upload_${upload.state}`,
    receivedBytes: upload.receivedBytes,
  });
}

export function registerFileUploadRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  opts: FileUploadRouteOptions = {},
): void {
  const uploads = new WorkspaceUploads(ctx.db);
  const now = opts.now ?? Date.now;
  // Decision 31: one part or completion in flight per session.
  const inFlight = new Set<string>();
  const logOf = (request: FastifyRequest): FileUploadLog =>
    opts.log ?? ((msg, data) => request.log.info(data, msg));

  /** The session in the guarded workspace; another caller's session is the uniform 404. */
  function session(
    request: FastifyRequest<UploadParams>,
    allowAdmin: boolean,
  ): { workspaceId: WorkspaceId; upload: WorkspaceUpload } {
    const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
    const upload = uploads.get(workspace.id, request.params.uploadId);
    const own = upload !== undefined && upload.uploader === actorLabel(request.principal);
    const admin = allowAdmin && !actsBelowAdmin(ctx, request, workspace.id);
    if (!upload || !(own || admin)) throw new DeskmatesError("not_found", "No such upload");
    return { workspaceId: workspace.id, upload };
  }

  /** Decision 31: expire idle sessions; a stopped workspace keeps them until it runs again. */
  async function expireIdle(workspaceId: WorkspaceId, log: FileUploadLog): Promise<void> {
    const cutoff = new Date(now() - WORKSPACE_UPLOAD_IDLE_TTL_MS).toISOString();
    const idle = uploads.idleSince(workspaceId, cutoff);
    if (idle.length === 0 || !(await ctx.sandboxes.peek(workspaceId))) return;
    for (const upload of idle) {
      try {
        await fileWrite(ctx, workspaceId, { op: "abort", uploadId: upload.id });
      } catch {
        continue;
      }
      uploads.end(workspaceId, upload.id, "expired");
      log("workspace upload expired", { workspaceId, uploadId: upload.id });
    }
  }

  function withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (inFlight.has(id))
      throw new DeskmatesError("invalid_transition", "Another request for this upload is running", {
        reason: "upload_busy",
      });
    inFlight.add(id);
    return work().finally(() => inFlight.delete(id));
  }

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/uploads", async (request, reply) => {
    const log = logOf(request);
    const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
    const uploader = actorLabel(request.principal);
    try {
      const input = parseCreate(request.body);
      await expireIdle(workspace.id, log);
      if (input.key !== undefined) {
        const existing = uploads.byIdempotencyKey(workspace.id, input.key);
        if (existing) {
          if (existing.uploader !== uploader)
            throw new DeskmatesError("validation", "idempotencyKey is in use", {
              field: "idempotencyKey",
            });
          return reply.code(200).send(existing);
        }
      }
      const quota = ctx.config.fileUploadWorkspaceQuotaBytes ?? 0;
      if (quota > 0 && uploads.reservedBytes(workspace.id) + input.sizeBytes > quota)
        throw new DeskmatesError(
          "payload_too_large",
          "The workspace upload quota would be exceeded",
          {
            reason: "workspace_upload_quota",
            quotaBytes: quota,
          },
        );
      if (!(await ctx.sandboxes.peek(workspace.id))) throw notRunning();
      const principal = request.principal;
      const upload = uploads.create({
        workspaceId: workspace.id,
        uploader,
        ...(principal?.kind === "user" ? { uploaderUserId: principal.userId } : {}),
        name: sanitizeUploadName(input.name),
        label: uploadLabel(input.name),
        sizeBytes: input.sizeBytes,
        ...(input.key === undefined ? {} : { idempotencyKey: input.key }),
      });
      try {
        await fileWrite(ctx, workspace.id, { op: "begin", uploadId: upload.id });
      } catch (error) {
        uploads.discard(workspace.id, upload.id);
        throw error;
      }
      log("workspace upload started", {
        workspaceId: workspace.id,
        uploadId: upload.id,
        sizeBytes: upload.sizeBytes,
        actor: uploader,
      });
      return reply.code(201).send(upload);
    } catch (error) {
      if (isDeskmatesError(error))
        log("workspace upload refused", {
          workspaceId: workspace.id,
          reason: typeof error.details.reason === "string" ? error.details.reason : error.code,
          actor: uploader,
        });
      throw error;
    }
  });

  app.get<UploadParams>("/api/workspaces/:id/uploads/:uploadId", async (request) => {
    const { workspaceId } = session(request, true);
    await expireIdle(workspaceId, logOf(request));
    return session(request, true).upload;
  });

  // The part's parser takes raw bytes up to one part, only in this scope; the client's content
  // type decides nothing else (decision 32).
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: WORKSPACE_FILE_UPLOAD_PART_BYTES },
      (_request, body, done) => done(null, body),
    );
    scope.put<UploadParams & { Querystring: { offset?: unknown } }>(
      "/api/workspaces/:id/uploads/:uploadId/parts",
      async (request) => {
        const log = logOf(request);
        const { workspaceId, upload } = session(request, false);
        try {
          if (upload.state !== "receiving") throw stateRefusal(upload);
          const offset = parseOffset(request.query.offset);
          const bytes = request.body;
          if (!Buffer.isBuffer(bytes) || bytes.length === 0)
            throw new DeskmatesError(
              "validation",
              "Expected one non-empty application/octet-stream part",
            );
          if (offset !== upload.receivedBytes)
            throw new DeskmatesError(
              "invalid_transition",
              "The part does not start at the received length",
              {
                reason: "upload_offset_mismatch",
                receivedBytes: upload.receivedBytes,
              },
            );
          if (offset + bytes.length > upload.sizeBytes)
            throw new DeskmatesError("validation", "The part goes past the declared size", {
              reason: "upload_exceeds_declared_size",
              sizeBytes: upload.sizeBytes,
            });
          return await withLock(upload.id, async () => {
            try {
              const result = await fileWrite(ctx, workspaceId, {
                op: "append",
                uploadId: upload.id,
                offset,
                base64: bytes.toString("base64"),
              });
              uploads.setReceived(workspaceId, upload.id, result.receivedBytes);
            } catch (error) {
              // Keep the record on the container's length so the client resumes from the truth.
              const received = isDeskmatesError(error) ? error.details.receivedBytes : undefined;
              if (typeof received === "number" && received <= upload.sizeBytes)
                uploads.setReceived(
                  workspaceId,
                  upload.id,
                  received,
                  isDeskmatesError(error) ? String(error.details.reason ?? error.code) : undefined,
                );
              throw error;
            }
            return uploads.get(workspaceId, upload.id) as WorkspaceUpload;
          });
        } catch (error) {
          if (isDeskmatesError(error))
            log("workspace upload part refused", {
              workspaceId,
              uploadId: upload.id,
              reason: typeof error.details.reason === "string" ? error.details.reason : error.code,
            });
          throw error;
        }
      },
    );
  });

  app.post<UploadParams>("/api/workspaces/:id/uploads/:uploadId/complete", async (request) => {
    const log = logOf(request);
    const { workspaceId, upload } = session(request, false);
    if (upload.state === "completed") return upload;
    if (upload.state !== "receiving") throw stateRefusal(upload);
    if (upload.receivedBytes !== upload.sizeBytes)
      throw new DeskmatesError(
        "invalid_transition",
        "The upload has not received its declared size",
        {
          reason: "upload_incomplete",
          receivedBytes: upload.receivedBytes,
        },
      );
    return await withLock(upload.id, async () => {
      const result = await fileWrite(ctx, workspaceId, {
        op: "commit",
        uploadId: upload.id,
        sizeBytes: upload.sizeBytes,
        dir: uploadDateDir(new Date(now())),
        name: upload.name,
      });
      const completed = ctx.db.transaction(() => {
        const done = uploads.complete(workspaceId, upload.id, result);
        ctx.audit.record({
          action: "file.upload",
          actor: upload.uploader,
          workspaceId,
          targetKind: "workspace_upload",
          targetId: upload.id,
          after: {
            path: result.path,
            sizeBytes: result.sizeBytes,
            sha256: result.sha256,
            label: upload.label,
          },
        });
        return done;
      })();
      log("workspace upload completed", {
        workspaceId,
        uploadId: upload.id,
        path: result.path,
        bytes: result.sizeBytes,
        actor: upload.uploader,
      });
      return completed;
    });
  });

  app.delete<UploadParams>("/api/workspaces/:id/uploads/:uploadId", async (request) => {
    const log = logOf(request);
    const { workspaceId, upload } = session(request, true);
    if (upload.state === "cancelled" || upload.state === "expired") return upload;
    // A completed upload's file is deleted by an Admin through `.../file` (decision 43).
    if (upload.state === "completed") throw stateRefusal(upload);
    return await withLock(upload.id, async () => {
      await fileWrite(ctx, workspaceId, { op: "abort", uploadId: upload.id });
      uploads.end(workspaceId, upload.id, "cancelled");
      log("workspace upload cancelled", {
        workspaceId,
        uploadId: upload.id,
        receivedBytes: upload.receivedBytes,
        actor: actorLabel(request.principal),
      });
      return uploads.get(workspaceId, upload.id) as WorkspaceUpload;
    });
  });

  // Decision 43: any Admin or Owner of the workspace deletes a completed upload's file. The
  // container command accepts only `/work/uploads/<date>/<safe name>`; the row stays as provenance.
  app.delete<UploadParams>("/api/workspaces/:id/uploads/:uploadId/file", async (request) => {
    const log = logOf(request);
    const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
    const upload = uploads.get(workspace.id, request.params.uploadId);
    if (!upload) throw new DeskmatesError("not_found", "No such upload");
    if (upload.deletedAt !== undefined) throw deletedRefusal();
    if (upload.state !== "completed" || upload.path === undefined) throw stateRefusal(upload);
    const path = upload.path;
    const actor = actorLabel(request.principal);
    return await withLock(upload.id, async () => {
      const result = await fileWrite(ctx, workspace.id, {
        op: "remove",
        uploadId: upload.id,
        path,
      });
      const deleted = ctx.db.transaction(() => {
        if (!uploads.markDeleted(workspace.id, upload.id, actor)) throw deletedRefusal();
        ctx.audit.record({
          action: "file.delete",
          actor,
          workspaceId: workspace.id,
          targetKind: "workspace_upload",
          targetId: upload.id,
          before: {
            path,
            sizeBytes: upload.sizeBytes,
            sha256: upload.sha256,
            label: upload.label,
          },
          after: { removed: result.removed },
        });
        return uploads.get(workspace.id, upload.id) as WorkspaceUpload;
      })();
      log("workspace upload deleted", {
        workspaceId: workspace.id,
        uploadId: upload.id,
        path,
        removed: result.removed,
        actor,
      });
      return { upload: deleted, removed: result.removed };
    });
  });
}

function deletedRefusal(): DeskmatesError {
  return new DeskmatesError("invalid_transition", "The upload's file was already deleted", {
    reason: "upload_deleted",
  });
}
