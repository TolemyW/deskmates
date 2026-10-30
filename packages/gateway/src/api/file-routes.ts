// ADR-0014 A3: authenticated, bounded workspace-file range reads and streamed downloads.
// The sandbox command reads at most one fixed-size range. The Gateway composes those ranges only
// as downstream asks for them, so no process or browser Blob buffers a complete large download.

import { Readable } from "node:stream";
import {
  DeskmatesError,
  WORKSPACE_FILE_MAX_BYTES_DEFAULT,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_RANGES,
  WORKSPACE_FILE_PREVIEW_TIMEOUT_MS,
  WORKSPACE_FILE_RANGE_BYTES,
  type WorkspaceFileReadRequest,
  type WorkspaceId,
  isDeskmatesError,
  workspaceFileRoot,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";

type FileRoute = { Params: { id: string }; Querystring: { path?: unknown } };

export type FileDownloadLog = (msg: string, data: Record<string, unknown>) => void;

export interface FileRouteOptions {
  log?: FileDownloadLog;
  /** Tests inject a clock to prove preview expiry without sleeping. */
  now?: () => number;
}

const OPERATOR_IDENTITY = "operator";
const EXEC_TIMEOUT_MS = 15_000;
const PREVIEW_ID = /^[A-Za-z0-9_-]{16,80}$/;
/**
 * Live preview identities one caller may hold at once in one workspace. The client chooses a
 * preview id and opens a fresh one per preview, so at the cap a new identity evicts the caller's
 * oldest finished one there (read to the end of the file first, then the longest idle); it is
 * refused only while every held identity has a range read in flight (#61 L2).
 */
export const PREVIEW_MAX_LIVE_PER_CALLER = 64;
const POLICY_MESSAGE =
  "Only regular files under /work/ or /home/<bot>/ of this workspace can be downloaded";

interface FileChunk {
  bytes: Buffer;
  offset: number;
  fileSize: number;
  eof: boolean;
}

interface PreviewBudget {
  /** The caller's actor label: a budget belongs to the person or principal that opened it. */
  caller: string;
  workspaceId: WorkspaceId;
  path: string;
  createdAt: number;
  /** When this identity last requested a range; the longest idle is evicted first. */
  usedAt: number;
  ranges: number;
  bytes: number;
  /** Range reads still in flight; an identity with one is mid-stream and never evicted. */
  inFlight: number;
  /** The identity has read the last byte of its file. */
  eof: boolean;
}

/**
 * Make room for a new preview identity of `caller` in `workspaceId`: below the cap nothing is
 * evicted; at the cap the caller's identity there that reached the end of its file goes first,
 * then the one idle longest. Returns false when every held identity is mid-stream.
 */
function makeRoomForPreview(
  budgets: Map<string, PreviewBudget>,
  caller: string,
  workspaceId: WorkspaceId,
): boolean {
  let held = 0;
  let victim: [string, PreviewBudget] | undefined;
  for (const entry of budgets) {
    const value = entry[1];
    if (value.caller !== caller || value.workspaceId !== workspaceId) continue;
    held += 1;
    if (value.inFlight > 0) continue;
    const current = victim?.[1];
    if (
      !current ||
      (value.eof && !current.eof) ||
      (value.eof === current.eof && value.usedAt < current.usedAt)
    )
      victim = entry;
  }
  if (held < PREVIEW_MAX_LIVE_PER_CALLER) return true;
  if (!victim) return false;
  budgets.delete(victim[0]);
  return true;
}

function refusal(code: string, maxBytes: number): DeskmatesError {
  switch (code) {
    case "forbidden":
      return new DeskmatesError("forbidden", POLICY_MESSAGE);
    case "payload_too_large":
      return new DeskmatesError(
        "payload_too_large",
        `File exceeds the ${maxBytes}-byte download limit`,
        { maxBytes },
      );
    case "not_found":
      return new DeskmatesError("not_found", "No such file in the workspace", {
        reason: "file_not_found",
      });
    case "validation":
      return new DeskmatesError("validation", "The workspace rejected the file request");
    default:
      return unavailable("File read failed inside the workspace");
  }
}

function unavailable(message: string): DeskmatesError {
  return new DeskmatesError("sandbox_unavailable", message);
}

function decodeBase64(value: string): Buffer | undefined {
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

async function readWorkspaceFileRange(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  path: string,
  botNames: string[],
  maxBytes: number,
  offset: number,
  length: number,
  allowFileAboveMaxBytes: boolean,
): Promise<FileChunk> {
  const handle = await ctx.sandboxes.peek(workspaceId);
  if (!handle)
    throw new DeskmatesError("not_found", "Workspace is not running; no file was read", {
      reason: "workspace_not_running",
    });
  const body: WorkspaceFileReadRequest = {
    path,
    botNames,
    maxBytes,
    offset,
    length,
    allowFileAboveMaxBytes,
  };
  let result: Awaited<ReturnType<GatewayContext["provider"]["exec"]>>;
  try {
    result = await ctx.provider.exec(handle, {
      cmd: ["deskmates-sidecar", "file-read"],
      stdin: JSON.stringify(body),
      timeoutMs: EXEC_TIMEOUT_MS,
    });
  } catch (error) {
    if (isDeskmatesError(error) && error.code === "sandbox_unavailable") throw error;
    throw unavailable("File read could not run in the workspace");
  }
  if (result.timedOut) throw unavailable("File read timed out");
  let value: {
    base64?: unknown;
    size?: unknown;
    fileSize?: unknown;
    offset?: unknown;
    eof?: unknown;
    error?: unknown;
  };
  try {
    value = JSON.parse(result.stdout.trim()) as typeof value;
  } catch {
    throw unavailable("File read returned an invalid response");
  }
  if (typeof value !== "object" || value === null)
    throw unavailable("File read returned an invalid response");
  if (result.exitCode !== 0)
    throw refusal(typeof value.error === "string" ? value.error : "internal", maxBytes);
  const bytes = typeof value.base64 === "string" ? decodeBase64(value.base64) : undefined;
  const fileSize = typeof value.fileSize === "number" ? value.fileSize : value.size;
  const returnedOffset = typeof value.offset === "number" ? value.offset : 0;
  const eof = typeof value.eof === "boolean" ? value.eof : true;
  if (
    bytes === undefined ||
    value.size !== bytes.length ||
    !Number.isSafeInteger(fileSize) ||
    (fileSize as number) < 0 ||
    returnedOffset !== offset ||
    bytes.length > length ||
    (!allowFileAboveMaxBytes && (fileSize as number) > maxBytes)
  )
    throw unavailable("File read returned an invalid response");
  return { bytes, offset, fileSize: fileSize as number, eof };
}

function parseRange(value: string | undefined): { start: number; length: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) throw new DeskmatesError("validation", "Expected one bounded byte range");
  const start = Number(match[1]);
  const end = match[2] === "" ? start + WORKSPACE_FILE_RANGE_BYTES - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end - start + 1 > WORKSPACE_FILE_RANGE_BYTES
  )
    throw new DeskmatesError("validation", "Expected one bounded byte range");
  return { start, length: end - start + 1 };
}

export function registerFileRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  opts: FileRouteOptions = {},
): void {
  const budgets = new Map<string, PreviewBudget>();
  const now = opts.now ?? Date.now;

  app.get<FileRoute>("/api/workspaces/:id/files", async (request, reply) => {
    const log: FileDownloadLog = opts.log ?? ((msg, data) => request.log.info(data, msg));
    const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
    const path = request.query.path;
    if (typeof path !== "string" || path === "")
      throw new DeskmatesError("validation", "Expected one ?path=<absolute path>");
    const filePath = path;
    const maxBytes = ctx.config.fileDownloadMaxBytes ?? WORKSPACE_FILE_MAX_BYTES_DEFAULT;
    const botNames = ctx.bots.list(workspace.id).map((bot) => bot.name);
    const filename = path.slice(path.lastIndexOf("/") + 1);
    try {
      if (workspaceFileRoot(path, botNames) === undefined) throw refusal("forbidden", maxBytes);
      const range = parseRange(
        typeof request.headers.range === "string" ? request.headers.range : undefined,
      );
      if (range) {
        const previewId = request.headers["x-deskmates-preview-id"];
        if (typeof previewId !== "string" || !PREVIEW_ID.test(previewId))
          throw new DeskmatesError("validation", "A valid preview identity is required for ranges");
        const caller = actorLabel(request.principal);
        const key = `${workspace.id}:${caller}:${previewId}`;
        const requestedAt = now();
        for (const [budgetKey, value] of budgets) {
          if (
            budgetKey !== key &&
            value.inFlight === 0 &&
            requestedAt - value.createdAt > WORKSPACE_FILE_PREVIEW_TIMEOUT_MS
          )
            budgets.delete(budgetKey);
        }
        const existing = budgets.get(key);
        if (existing && (existing.workspaceId !== workspace.id || existing.path !== path))
          throw new DeskmatesError("forbidden", "A preview identity is bound to one file");
        if (!existing && !makeRoomForPreview(budgets, caller, workspace.id))
          throw new DeskmatesError("rate_limited", "Too many file previews are open at once", {
            reason: "preview_limit",
            maxPreviews: PREVIEW_MAX_LIVE_PER_CALLER,
          });
        const budget = existing ?? {
          caller,
          workspaceId: workspace.id,
          path,
          createdAt: requestedAt,
          usedAt: requestedAt,
          ranges: 0,
          bytes: 0,
          inFlight: 0,
          eof: false,
        };
        if (requestedAt - budget.createdAt > WORKSPACE_FILE_PREVIEW_TIMEOUT_MS) {
          budgets.delete(key);
          throw new DeskmatesError("validation", "The file preview expired", {
            reason: "preview_timeout",
          });
        }
        if (
          budget.ranges + 1 > WORKSPACE_FILE_PREVIEW_MAX_RANGES ||
          budget.bytes + range.length > WORKSPACE_FILE_PREVIEW_MAX_BYTES
        )
          throw new DeskmatesError("payload_too_large", "The file preview budget was exhausted", {
            reason: "preview_budget",
            maxBytes: WORKSPACE_FILE_PREVIEW_MAX_BYTES,
            maxRanges: WORKSPACE_FILE_PREVIEW_MAX_RANGES,
          });
        budget.ranges += 1;
        budget.bytes += range.length;
        budget.usedAt = requestedAt;
        budget.inFlight += 1;
        budgets.set(key, budget);
        let chunk: FileChunk;
        try {
          chunk = await readWorkspaceFileRange(
            ctx,
            workspace.id,
            path,
            botNames,
            maxBytes,
            range.start,
            range.length,
            true,
          );
        } finally {
          budget.inFlight -= 1;
        }
        if (chunk.eof || range.start + chunk.bytes.length >= chunk.fileSize) budget.eof = true;
        if (range.start >= chunk.fileSize)
          return reply.code(416).header("content-range", `bytes */${chunk.fileSize}`).send();
        const end = range.start + chunk.bytes.length - 1;
        log("workspace file preview range read", {
          workspaceId: workspace.id,
          path,
          offset: range.start,
          bytes: chunk.bytes.length,
          operator: OPERATOR_IDENTITY,
        });
        return reply
          .code(206)
          .header("content-type", "application/octet-stream")
          .header("content-disposition", `inline; filename="${filename}"`)
          .header("content-range", `bytes ${range.start}-${end}/${chunk.fileSize}`)
          .header("content-length", chunk.bytes.length)
          .header("accept-ranges", "bytes")
          .header("x-content-type-options", "nosniff")
          .header("cache-control", "no-store")
          .send(chunk.bytes);
      }

      const first = await readWorkspaceFileRange(
        ctx,
        workspace.id,
        path,
        botNames,
        maxBytes,
        0,
        WORKSPACE_FILE_RANGE_BYTES,
        false,
      );
      let cancelled = false;
      reply.raw.once("close", () => {
        cancelled = true;
      });
      async function* stream(): AsyncGenerator<Buffer> {
        let chunk = first;
        let sent = 0;
        try {
          for (;;) {
            if (cancelled) return;
            if (chunk.bytes.length > 0) {
              sent += chunk.bytes.length;
              yield chunk.bytes;
            }
            if (chunk.eof || sent >= chunk.fileSize) break;
            chunk = await readWorkspaceFileRange(
              ctx,
              workspace.id,
              filePath,
              botNames,
              maxBytes,
              sent,
              Math.min(WORKSPACE_FILE_RANGE_BYTES, chunk.fileSize - sent),
              false,
            );
            if (chunk.fileSize !== first.fileSize)
              throw unavailable("File changed while it was being downloaded");
          }
          log("workspace file downloaded", {
            workspaceId: workspace.id,
            path,
            bytes: sent,
            operator: OPERATOR_IDENTITY,
          });
        } finally {
          if (cancelled)
            log("workspace file download cancelled", {
              workspaceId: workspace.id,
              path,
              bytes: sent,
              operator: OPERATOR_IDENTITY,
            });
        }
      }
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${filename}"`)
        .header("content-length", first.fileSize)
        .header("accept-ranges", "bytes")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .send(Readable.from(stream()));
    } catch (error) {
      if (isDeskmatesError(error) && error.code !== "sandbox_unavailable")
        log("workspace file download refused", {
          workspaceId: workspace.id,
          path,
          reason: typeof error.details.reason === "string" ? error.details.reason : error.code,
          operator: OPERATOR_IDENTITY,
        });
      throw error;
    }
  });
}
