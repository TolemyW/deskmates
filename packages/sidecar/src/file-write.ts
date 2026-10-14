// `deskmates-sidecar file-write`: the container half of a workspace upload (ADR-0014 amendment A5).
// The Gateway runs this fixed command with the request on stdin; no path or name ever reaches a
// shell or argv. The command writes only under `/work/uploads/`: partial bytes go to
// `.partial/<upload id>.part`, created exclusively and without following links, and completion
// hard-links the partial file to the first free name in the date directory, so an existing file
// is never overwritten. Every directory on the way must be a real directory, not a link.

import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  WORKSPACE_FILE_UPLOAD_PART_BYTES,
  WORKSPACE_UPLOAD_DATE_DIR,
  WORKSPACE_UPLOAD_ID,
  WORKSPACE_UPLOAD_NAME,
  WORKSPACE_UPLOAD_NAME_MAX,
  WORKSPACE_UPLOAD_PARTIAL_DIR,
  WORKSPACE_UPLOAD_ROOT,
  type WorkspaceFileWriteErrorCode,
  type WorkspaceFileWriteFailure,
  type WorkspaceFileWriteRequest,
  type WorkspaceFileWriteResult,
} from "@deskmates/contracts";

/** A refusal with one of the codes the Gateway maps to a typed error. */
export class FileWriteError extends Error {
  readonly code: WorkspaceFileWriteErrorCode;
  readonly receivedBytes: number | undefined;
  constructor(code: WorkspaceFileWriteErrorCode, message: string, receivedBytes?: number) {
    super(message);
    this.name = "FileWriteError";
    this.code = code;
    this.receivedBytes = receivedBytes;
  }
}

// Fixed messages: a refusal names the policy, never a filesystem detail such as a link target.
const refused = (): FileWriteError =>
  new FileWriteError("forbidden", "Uploads are written only into real directories under /work/");
const invalid = (): FileWriteError =>
  new FileWriteError("validation", "Invalid file-write request");

/** Mode of a partial or final upload: owner read-write, group read, never executable. */
const FILE_MODE = 0o640;
const DIR_MODE = 0o755;
/** Highest collision suffix tried before the commit gives up. */
const MAX_SUFFIX = 10_000;
const HASH_CHUNK_BYTES = 1024 * 1024;

function isErrno(error: unknown, ...codes: string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

function storageError(error: unknown): boolean {
  return isErrno(error, "ENOSPC", "EDQUOT");
}

function exhausted(receivedBytes?: number): FileWriteError {
  return new FileWriteError(
    "storage_exhausted",
    "The workspace has no space left for this upload",
    receivedBytes,
  );
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseRequest(input: unknown): WorkspaceFileWriteRequest {
  if (typeof input !== "object" || input === null) throw invalid();
  const r = input as Record<string, unknown>;
  if (typeof r.uploadId !== "string" || !WORKSPACE_UPLOAD_ID.test(r.uploadId)) throw invalid();
  switch (r.op) {
    case "begin":
    case "abort":
      return { op: r.op, uploadId: r.uploadId };
    case "append":
      if (!isCount(r.offset) || typeof r.base64 !== "string") throw invalid();
      return { op: "append", uploadId: r.uploadId, offset: r.offset, base64: r.base64 };
    case "commit":
      if (
        !isCount(r.sizeBytes) ||
        typeof r.dir !== "string" ||
        !WORKSPACE_UPLOAD_DATE_DIR.test(r.dir) ||
        typeof r.name !== "string" ||
        r.name.length > WORKSPACE_UPLOAD_NAME_MAX ||
        !WORKSPACE_UPLOAD_NAME.test(r.name)
      )
        throw invalid();
      return {
        op: "commit",
        uploadId: r.uploadId,
        sizeBytes: r.sizeBytes,
        dir: r.dir,
        name: r.name,
      };
    default:
      throw invalid();
  }
}

/**
 * The real directory `/work/<segments...>` under `root`, creating the missing ones when asked.
 * `/work` itself is never created. Any link or non-directory on the way is refused.
 */
function realDirectory(root: string, segments: readonly string[], create: boolean): string {
  let dir = join(root, "work");
  const check = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused();
  };
  try {
    check(dir);
  } catch (error) {
    if (error instanceof FileWriteError) throw error;
    throw refused();
  }
  for (const segment of segments) {
    dir = join(dir, segment);
    try {
      check(dir);
    } catch (error) {
      if (error instanceof FileWriteError) throw error;
      if (!create || !isErrno(error, "ENOENT")) throw refused();
      try {
        mkdirSync(dir, { mode: DIR_MODE });
      } catch (mkdirError) {
        if (storageError(mkdirError)) throw exhausted();
        if (!isErrno(mkdirError, "EEXIST")) throw refused();
      }
      check(dir);
    }
  }
  return dir;
}

const UPLOADS = WORKSPACE_UPLOAD_ROOT.split("/").slice(2); // ["uploads"]

function partialPath(root: string, uploadId: string, create: boolean): string {
  return join(
    realDirectory(root, [...UPLOADS, WORKSPACE_UPLOAD_PARTIAL_DIR], create),
    uploadId,
  ).concat(".part");
}

/** Open the partial file for `flags`, refusing a link or anything but a regular file. */
function openPartial(path: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new FileWriteError("not_found", "No such upload");
    throw refused();
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw refused();
  }
  return fd;
}

function begin(root: string, uploadId: string): WorkspaceFileWriteResult {
  const path = partialPath(root, uploadId, true);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
  } catch (error) {
    if (storageError(error)) throw exhausted();
    throw refused();
  }
  closeSync(fd);
  return { op: "begin", receivedBytes: 0 };
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > WORKSPACE_FILE_UPLOAD_PART_BYTES)
    throw invalid();
  return bytes;
}

function append(
  root: string,
  request: Extract<WorkspaceFileWriteRequest, { op: "append" }>,
): WorkspaceFileWriteResult {
  const bytes = decodeBase64(request.base64);
  const fd = openPartial(partialPath(root, request.uploadId, false), constants.O_WRONLY);
  try {
    const size = fstatSync(fd).size;
    if (size !== request.offset)
      throw new FileWriteError(
        "offset_mismatch",
        "The part does not start at the received length",
        size,
      );
    let written = 0;
    try {
      while (written < bytes.length)
        written += writeSync(fd, bytes, written, bytes.length - written, request.offset + written);
    } catch (error) {
      // Leave the partial file at its previous length so the session stays resumable.
      ftruncateSync(fd, request.offset);
      if (storageError(error)) throw exhausted(request.offset);
      throw error;
    }
    return { op: "append", receivedBytes: request.offset + bytes.length };
  } finally {
    closeSync(fd);
  }
}

function sha256Of(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const read = readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}

/** `name`, then `stem-2.ext`, `stem-3.ext`, ... with the extension kept. */
function candidate(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

function commit(
  root: string,
  request: Extract<WorkspaceFileWriteRequest, { op: "commit" }>,
): WorkspaceFileWriteResult {
  const partial = partialPath(root, request.uploadId, false);
  const fd = openPartial(partial, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    if (stat.size !== request.sizeBytes)
      throw new FileWriteError(
        "size_mismatch",
        "The upload has not received its declared size",
        stat.size,
      );
    const sha256 = sha256Of(fd);
    const dir = realDirectory(root, [...UPLOADS, request.dir], true);
    for (let n = 1; n <= MAX_SUFFIX; n += 1) {
      const name = candidate(request.name, n);
      const target = join(dir, name);
      try {
        // link(2) fails with EEXIST instead of replacing: an existing file is never overwritten.
        linkSync(partial, target);
      } catch (error) {
        if (isErrno(error, "EEXIST")) continue;
        if (storageError(error)) throw exhausted(stat.size);
        throw refused();
      }
      // The partial path may have been swapped between the open and the link; keep the link only
      // when it names the very file that was checked and hashed.
      const linked = lstatSync(target);
      if (!linked.isFile() || linked.ino !== stat.ino || linked.dev !== stat.dev) {
        unlinkSync(target);
        throw refused();
      }
      unlinkSync(partial);
      return {
        op: "commit",
        path: `${WORKSPACE_UPLOAD_ROOT}/${request.dir}/${name}`,
        sizeBytes: stat.size,
        sha256,
      };
    }
    throw refused();
  } finally {
    closeSync(fd);
  }
}

function abort(root: string, uploadId: string): WorkspaceFileWriteResult {
  let path: string;
  try {
    path = partialPath(root, uploadId, false);
  } catch (error) {
    // No partial directory at all: nothing was ever written.
    if (error instanceof FileWriteError && error.code === "forbidden") {
      try {
        lstatSync(join(root, "work", ...UPLOADS, WORKSPACE_UPLOAD_PARTIAL_DIR));
      } catch {
        return { op: "abort", removed: false };
      }
    }
    throw error;
  }
  try {
    // unlink(2) removes a link itself, never its target.
    unlinkSync(path);
    return { op: "abort", removed: true };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { op: "abort", removed: false };
    throw refused();
  }
}

/** Apply the request; `root` stands for the container's `/`, tests pass a temporary directory. */
export function writeWorkspaceFile(input: unknown, root = "/"): WorkspaceFileWriteResult {
  const request = parseRequest(input);
  switch (request.op) {
    case "begin":
      return begin(root, request.uploadId);
    case "append":
      return append(root, request);
    case "commit":
      return commit(root, request);
    case "abort":
      return abort(root, request.uploadId);
  }
}

/** The CLI body: stdin text in, one JSON line and an exit code out. */
export function fileWriteCommand(stdin: string, root = "/"): { stdout: string; exitCode: number } {
  let body: WorkspaceFileWriteResult | WorkspaceFileWriteFailure;
  let exitCode = 0;
  try {
    let input: unknown;
    try {
      input = JSON.parse(stdin);
    } catch {
      throw invalid();
    }
    body = writeWorkspaceFile(input, root);
  } catch (error) {
    exitCode = 1;
    body =
      error instanceof FileWriteError
        ? {
            error: error.code,
            message: error.message,
            ...(error.receivedBytes === undefined ? {} : { receivedBytes: error.receivedBytes }),
          }
        : storageError(error)
          ? {
              error: "storage_exhausted",
              message: "The workspace has no space left for this upload",
            }
          : { error: "internal", message: "File write failed" };
  }
  return { stdout: `${JSON.stringify(body)}\n`, exitCode };
}
