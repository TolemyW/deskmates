// Server verification of a formal delivery's files (ADR-0014 amendment A4, decision 23). The
// Gateway runs the fixed `deskmates-sidecar file-read` command in digest mode: the container applies
// decision 2 unchanged (lexical policy, realpath under /work or a bot home, no symlink escape,
// regular file, size cap) and returns size and SHA-256. Nothing the agent names runs, and a
// stopped workspace is reported, never started. Every artifact is checked before anything is
// written; one failure refuses the whole delivery with a reason per path.

import {
  DeskmatesError,
  FILE_DIGEST_CHECK,
  type IsoTimestamp,
  WORKSPACE_FILE_MAX_BYTES_DEFAULT,
  type WorkspaceFileReadRequest,
  type WorkspaceId,
  workspaceFileRoot,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

const EXEC_TIMEOUT_MS = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;

export interface VerifiedFile {
  path: string;
  sizeBytes: number;
  sha256: string;
  check: string;
  checkedAt: IsoTimestamp;
}

/** Why one path failed; the bot sees every reason and can fix and retry. */
export type VerificationFailure =
  | "forbidden"
  | "not_found"
  | "payload_too_large"
  | "unavailable"
  | "invalid_response";

type VerifyContext = Pick<GatewayContext, "sandboxes" | "provider" | "bots" | "config">;

/**
 * Verify every path, or throw. `workspace_not_running` when no sandbox handle is cached;
 * `validation` with `details.errors` (one line per failed path) otherwise.
 */
export async function verifyWorkspaceFiles(
  ctx: VerifyContext,
  workspaceId: WorkspaceId,
  paths: readonly string[],
  clock: () => Date = () => new Date(),
): Promise<Map<string, VerifiedFile>> {
  const verified = new Map<string, VerifiedFile>();
  if (paths.length === 0) return verified;
  const botNames = ctx.bots.list(workspaceId).map((bot) => bot.name);
  const maxBytes = ctx.config.fileDownloadMaxBytes ?? WORKSPACE_FILE_MAX_BYTES_DEFAULT;
  const handle = await ctx.sandboxes.peek(workspaceId);
  if (!handle)
    throw new DeskmatesError(
      "invalid_transition",
      "The workspace is not running, so the delivered files could not be verified; nothing was delivered",
      { reason: "workspace_not_running" },
    );
  const errors: string[] = [];
  for (const path of paths) {
    if (workspaceFileRoot(path, botNames) === undefined) {
      errors.push(`${path}: forbidden (only /work/ or /home/<bot>/ of this workspace)`);
      continue;
    }
    const outcome = await digest(ctx, handle, { path, botNames, maxBytes, digest: true });
    if (typeof outcome === "string") {
      errors.push(`${path}: ${outcome}`);
      continue;
    }
    verified.set(path, {
      path,
      sizeBytes: outcome.fileSize,
      sha256: outcome.sha256,
      check: FILE_DIGEST_CHECK,
      checkedAt: clock().toISOString() as IsoTimestamp,
    });
  }
  if (errors.length > 0)
    throw new DeskmatesError(
      "validation",
      "Some delivered files could not be verified; nothing was delivered",
      { errors, reason: "verification_failed" },
    );
  return verified;
}

async function digest(
  ctx: VerifyContext,
  handle: NonNullable<Awaited<ReturnType<GatewayContext["sandboxes"]["peek"]>>>,
  request: WorkspaceFileReadRequest,
): Promise<{ fileSize: number; sha256: string } | VerificationFailure> {
  let result: Awaited<ReturnType<GatewayContext["provider"]["exec"]>>;
  try {
    result = await ctx.provider.exec(handle, {
      cmd: ["deskmates-sidecar", "file-read"],
      stdin: JSON.stringify(request),
      timeoutMs: EXEC_TIMEOUT_MS,
    });
  } catch {
    return "unavailable";
  }
  if (result.timedOut) return "unavailable";
  let value: { fileSize?: unknown; sha256?: unknown; error?: unknown };
  try {
    value = JSON.parse(result.stdout.trim()) as typeof value;
  } catch {
    return "invalid_response";
  }
  if (typeof value !== "object" || value === null) return "invalid_response";
  if (result.exitCode !== 0) {
    const code = value.error;
    return code === "forbidden" || code === "not_found" || code === "payload_too_large"
      ? code
      : "unavailable";
  }
  // An older workspace image ignores `digest` and answers with content: never a verification.
  if (
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    typeof value.fileSize !== "number" ||
    !Number.isSafeInteger(value.fileSize) ||
    value.fileSize < 0
  )
    return "invalid_response";
  return { fileSize: value.fileSize, sha256: value.sha256 };
}
