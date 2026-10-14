// `deskmates-sidecar file-read`: read one workspace file for the operator download route
// (ADR-0014 decisions 2 and 3). The Gateway runs this fixed command with the request on stdin;
// the path is never part of a shell string. Inside the container the command resolves the path
// with `realpath`, so a symlink planted in /work that points into /profile is refused, checks
// that the target is a regular file and its size before reading, and prints base64 content.

import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import {
  WORKSPACE_FILE_RANGE_BYTES,
  type WorkspaceFileDigestResult,
  type WorkspaceFileReadErrorCode,
  type WorkspaceFileReadFailure,
  type WorkspaceFileReadResult,
  workspaceFileRoot,
} from "@deskmates/contracts";

const BOT_NAME = /^[A-Za-z0-9_-]+$/;

/** A refusal with one of the codes the Gateway maps to a typed error. */
export class FileReadError extends Error {
  readonly code: WorkspaceFileReadErrorCode;
  constructor(code: WorkspaceFileReadErrorCode, message: string) {
    super(message);
    this.name = "FileReadError";
    this.code = code;
  }
}

// Fixed messages: a refusal names the policy, never a filesystem detail such as a link target.
const refused = (): FileReadError =>
  new FileReadError(
    "forbidden",
    "Only regular files under /work/ or /home/<bot>/ of this workspace can be downloaded",
  );

function parseRequest(input: unknown): {
  path: string;
  botNames: string[];
  maxBytes: number;
  offset: number;
  length?: number;
  allowFileAboveMaxBytes: boolean;
  digest: boolean;
} {
  const request = input as {
    path?: unknown;
    botNames?: unknown;
    maxBytes?: unknown;
    offset?: unknown;
    length?: unknown;
    allowFileAboveMaxBytes?: unknown;
    digest?: unknown;
  } | null;
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.path !== "string" ||
    !Array.isArray(request.botNames) ||
    !request.botNames.every((name) => typeof name === "string" && BOT_NAME.test(name)) ||
    typeof request.maxBytes !== "number" ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes <= 0 ||
    (request.offset !== undefined &&
      (typeof request.offset !== "number" ||
        !Number.isSafeInteger(request.offset) ||
        request.offset < 0)) ||
    (request.length !== undefined &&
      (typeof request.length !== "number" ||
        !Number.isSafeInteger(request.length) ||
        request.length < 1 ||
        request.length > WORKSPACE_FILE_RANGE_BYTES)) ||
    (request.allowFileAboveMaxBytes !== undefined &&
      typeof request.allowFileAboveMaxBytes !== "boolean") ||
    (request.allowFileAboveMaxBytes === true && request.length === undefined) ||
    (request.digest !== undefined && typeof request.digest !== "boolean") ||
    // Digest mode reads the whole file under the cap; a range or the cap override makes no sense.
    (request.digest === true &&
      (request.length !== undefined ||
        request.allowFileAboveMaxBytes === true ||
        (request.offset !== undefined && request.offset !== 0)))
  )
    throw new FileReadError("validation", "Invalid file-read request");
  return {
    path: request.path,
    botNames: request.botNames as string[],
    maxBytes: request.maxBytes,
    offset: (request.offset as number | undefined) ?? 0,
    ...(request.length === undefined ? {} : { length: request.length as number }),
    allowFileAboveMaxBytes: request.allowFileAboveMaxBytes === true,
    digest: request.digest === true,
  };
}

/** Bytes hashed per read in digest mode. */
const DIGEST_CHUNK_BYTES = 1024 * 1024;

/** Real path of an allowed root, or undefined when it is missing or is itself a link. */
function realRoot(root: string, logical: string): string | undefined {
  const dir = join(root, logical);
  try {
    if (lstatSync(dir).isSymbolicLink()) return undefined;
    return realpathSync(dir);
  } catch {
    return undefined;
  }
}

function isErrno(error: unknown, ...codes: string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

/**
 * Apply ADR-0014 decision 2 and read the file. `root` stands for the container's `/`; tests pass
 * a temporary directory. Throws FileReadError with `validation`, `forbidden`, `not_found` or
 * `payload_too_large`.
 */
export function readWorkspaceFile(input: unknown, root = "/"): WorkspaceFileReadResult {
  const request = parseRequest(input);
  if (request.digest) throw new FileReadError("validation", "Invalid file-read request");
  return withCheckedFile(request, root, (fd, size) => readRange(request, fd, size));
}

/**
 * Digest mode (ADR-0014 A4 decision 23): the same policy as a read, then SHA-256 over the whole
 * regular file, at most `maxBytes`. A file that grows past the cap while hashing is refused.
 */
export function digestWorkspaceFile(input: unknown, root = "/"): WorkspaceFileDigestResult {
  const request = parseRequest(input);
  if (!request.digest) throw new FileReadError("validation", "Invalid file-read request");
  return withCheckedFile(request, root, (fd, size) => {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(DIGEST_CHUNK_BYTES, Math.max(size, 1)));
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      total += read;
      if (total > request.maxBytes)
        throw new FileReadError(
          "payload_too_large",
          `File exceeds the ${request.maxBytes}-byte download limit`,
        );
      hash.update(buffer.subarray(0, read));
    }
    return { fileSize: total, sha256: hash.digest("hex") };
  });
}

function withCheckedFile<T>(
  request: ReturnType<typeof parseRequest>,
  root: string,
  use: (fd: number, size: number) => T,
): T {
  if (workspaceFileRoot(request.path, request.botNames) === undefined) throw refused();

  let resolved: string;
  try {
    resolved = realpathSync(join(root, request.path));
  } catch (error) {
    if (isErrno(error, "ENOENT", "ENOTDIR"))
      throw new FileReadError("not_found", "No such file in the workspace");
    throw refused();
  }
  // After links, the file must sit under /work or under the home of a bot of this workspace,
  // whichever root the requested path named. A link from one allowed root into another is fine.
  const allowedRoots = ["/work", ...request.botNames.map((name) => `/home/${name}`)]
    .map((logical) => realRoot(root, logical))
    .filter((dir): dir is string => dir !== undefined);
  if (!allowedRoots.some((dir) => resolved.startsWith(`${dir}${sep}`))) throw refused();

  let fd: number;
  try {
    // O_NOFOLLOW: the last component was resolved above and must not have become a link since.
    // O_NONBLOCK: opening a FIFO must not hang the command; fstat refuses it next.
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      throw new FileReadError("not_found", "No such file in the workspace");
    throw refused();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw refused();
    const tooLarge = new FileReadError(
      "payload_too_large",
      `File exceeds the ${request.maxBytes}-byte download limit`,
    );
    if (stat.size > request.maxBytes && !request.allowFileAboveMaxBytes) throw tooLarge;
    return use(fd, stat.size);
  } finally {
    closeSync(fd);
  }
}

function readRange(
  request: ReturnType<typeof parseRequest>,
  fd: number,
  size: number,
): WorkspaceFileReadResult {
  const tooLarge = new FileReadError(
    "payload_too_large",
    `File exceeds the ${request.maxBytes}-byte download limit`,
  );
  const remaining = Math.max(0, size - request.offset);
  const requestedLength = request.length ?? request.maxBytes + 1;
  const capacity = Math.min(requestedLength, remaining);
  const buffer = Buffer.alloc(capacity);
  let length = 0;
  while (length < buffer.length) {
    const read = readSync(fd, buffer, length, buffer.length - length, request.offset + length);
    if (read === 0) break;
    length += read;
  }
  // A legacy whole-file request still notices growth beyond its cap.
  if (request.length === undefined && length > request.maxBytes) throw tooLarge;
  return {
    base64: buffer.subarray(0, length).toString("base64"),
    size: length,
    fileSize: size,
    offset: request.offset,
    eof: request.offset + length >= size,
  };
}

/** The CLI body: stdin text in, one JSON line and an exit code out. */
export function fileReadCommand(stdin: string, root = "/"): { stdout: string; exitCode: number } {
  let body: WorkspaceFileReadResult | WorkspaceFileDigestResult | WorkspaceFileReadFailure;
  let exitCode = 0;
  try {
    let input: unknown;
    try {
      input = JSON.parse(stdin);
    } catch {
      throw new FileReadError("validation", "Invalid file-read request");
    }
    body =
      typeof input === "object" && input !== null && (input as { digest?: unknown }).digest === true
        ? digestWorkspaceFile(input, root)
        : readWorkspaceFile(input, root);
  } catch (error) {
    exitCode = 1;
    body =
      error instanceof FileReadError
        ? { error: error.code, message: error.message }
        : { error: "internal", message: "File read failed" };
  }
  return { stdout: `${JSON.stringify(body)}\n`, exitCode };
}
