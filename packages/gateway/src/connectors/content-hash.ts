// The content hash of ADR-0012: sha256 of the canonical JSON from contracts, lowercase hex. The
// sidecar computes the same value; the Gateway computes it itself rather than trust either side.

import { createHash } from "node:crypto";
import { canonicalJson } from "@deskmates/contracts";

export function contentHash(submission: unknown): string {
  return createHash("sha256").update(canonicalJson(submission)).digest("hex");
}
