// Browser ledger evidence (issue #65): the sidecar writes a bounded, redacted full-result
// artifact and records this reference on a `tool_result` event; the web UI links it through the
// ADR-0014 authenticated workspace file route. The payload is untrusted, so the UI only links a
// path that names a cache file directly inside the evidence directory.

/** Workspace directory holding evidence artifacts. */
export const BROWSER_EVIDENCE_DIR = "/work/browser-evidence";

/** File name of one artifact: a random UUID with a `.txt` extension. */
export const BROWSER_EVIDENCE_FILE = /^[0-9a-f-]{36}\.txt$/;

/** `tool_result.payload.evidence` when an artifact was written. */
export interface ToolEvidenceReference {
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  /** Cleanup eligibility, not a guarantee the file exists until then. */
  expiresAt: string;
}

/** `tool_result.payload.evidence` when no artifact could be written. */
export interface ToolEvidenceUnavailable {
  unavailable: string;
}

/** Whether a value is a path to one artifact directly under {@link BROWSER_EVIDENCE_DIR}. */
export function isBrowserEvidencePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const prefix = `${BROWSER_EVIDENCE_DIR}/`;
  return path.startsWith(prefix) && BROWSER_EVIDENCE_FILE.test(path.slice(prefix.length));
}
