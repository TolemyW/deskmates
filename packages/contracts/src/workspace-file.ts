// Operator download of one workspace file by path (ADR-0014). The Gateway validates the path
// shape before any exec; the sidecar's `file-read` command applies the same lexical check and
// then the filesystem half (`realpath`, regular file, size) inside the container.

/** Default single-file download cap: 1 GiB (ADR-0014 amendment A3 decision 17). */
export const WORKSPACE_FILE_MAX_BYTES_DEFAULT = 1024 * 1024 * 1024;
/** One fixed-command transfer. 64 such ranges fill the preview byte budget exactly. */
export const WORKSPACE_FILE_RANGE_BYTES = 1024 * 1024;
export const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_FILE_PREVIEW_MAX_RANGES = 64;
export const WORKSPACE_FILE_PREVIEW_TIMEOUT_MS = 60_000;

/** Characters a downloadable path may contain (ADR-0014 decision 2). */
export const WORKSPACE_FILE_PATH_CHARS = /^[A-Za-z0-9._\-/]+$/;

const BOT_NAME = /^[A-Za-z0-9_-]+$/;

/** stdin of `deskmates-sidecar file-read`. The path travels here, never in argv or a shell. */
export interface WorkspaceFileReadRequest {
  path: string;
  /** Names of the bots of the workspace; `/home/<name>/` is readable for each. */
  botNames: string[];
  maxBytes: number;
  /** First byte to read. Omitted only for compatibility with older direct callers. */
  offset?: number;
  /** Bounded bytes to read; never larger than `WORKSPACE_FILE_RANGE_BYTES`. */
  length?: number;
  /** A preview range may inspect a prefix of a file above the download cap. */
  allowFileAboveMaxBytes?: boolean;
  /**
   * Verification mode (ADR-0014 A4 decision 23): apply the same policy, read the whole file up to
   * `maxBytes` inside the container and return its size and SHA-256 instead of content.
   */
  digest?: boolean;
}

/** stdout of `file-read` in digest mode on exit 0. */
export interface WorkspaceFileDigestResult {
  fileSize: number;
  sha256: string;
}

/** The check identity recorded on a publication. */
export const FILE_DIGEST_CHECK = "file-read-digest-v1";

/** stdout of `deskmates-sidecar file-read` on exit 0. */
export interface WorkspaceFileReadResult {
  base64: string;
  /** Bytes in this response, not the whole-file size. */
  size: number;
  /** Current regular-file size observed before this range was read. */
  fileSize?: number;
  offset?: number;
  eof?: boolean;
}

export type WorkspaceFileReadErrorCode =
  | "validation"
  | "forbidden"
  | "not_found"
  | "payload_too_large";

/** stdout of `deskmates-sidecar file-read` on a non-zero exit. */
export interface WorkspaceFileReadFailure {
  error: WorkspaceFileReadErrorCode | "internal";
  message: string;
}

/**
 * The lexical half of ADR-0014 decision 2. Returns the allowed root the path sits under
 * (`/work` or `/home/<bot>`), or undefined when the path is not absolute, uses a character
 * outside the allowed set, has a `..` segment, or is outside every allowed root. A path equal
 * to a root, or ending in `/`, names a directory and is refused here already.
 */
export function workspaceFileRoot(path: string, botNames: readonly string[]): string | undefined {
  if (!path.startsWith("/") || !WORKSPACE_FILE_PATH_CHARS.test(path) || path.endsWith("/"))
    return undefined;
  const segments = path.split("/").slice(1);
  if (segments.some((segment) => segment === ".." || segment === "")) return undefined;
  if (segments[0] === "work" && segments.length >= 2) return "/work";
  if (
    segments[0] === "home" &&
    segments.length >= 3 &&
    BOT_NAME.test(segments[1] as string) &&
    botNames.includes(segments[1] as string)
  )
    return `/home/${segments[1]}`;
  return undefined;
}
