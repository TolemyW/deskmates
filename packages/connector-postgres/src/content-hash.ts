// The content hash of ADR-0012: sha256 of the canonical JSON from contracts, lowercase hex. The
// Gateway computes the same value over the same body; a submit names the hash it validated.

import { createHash } from "node:crypto";
import { canonicalJson } from "@deskmates/contracts";

export function contentHash(submission: unknown): string {
  return createHash("sha256").update(canonicalJson(submission)).digest("hex");
}
