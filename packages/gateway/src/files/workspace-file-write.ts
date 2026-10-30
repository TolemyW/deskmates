// The one way the Gateway writes upload bytes into a workspace (ADR-0014 amendment A5 decision 31):
// the fixed container command `deskmates-sidecar file-write` with the request on stdin. Shared by
// the Web upload routes and by channel image ingress (ADR-0047 decision 12), so an image a person
// sends through a channel lands exactly where a Web upload does.

import {
  DeskmatesError,
  type WorkspaceFileWriteFailure,
  type WorkspaceFileWriteRequest,
  type WorkspaceFileWriteResult,
  type WorkspaceId,
  isDeskmatesError,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

/** A part of up to 4 MiB is about 5.6 MB of base64 on stdin; leave room for a slow disk. */
const EXEC_TIMEOUT_MS = 60_000;
const POLICY_MESSAGE = "Uploads are written only into real directories under /work/uploads/";

export function notRunning(): DeskmatesError {
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
export async function fileWrite<T extends WorkspaceFileWriteResult["op"]>(
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
