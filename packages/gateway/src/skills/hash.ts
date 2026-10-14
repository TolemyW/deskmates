// A skill's identity is its name and the SHA-256 of its content (ADR-0015 definitions): the hex
// digest of the canonical JSON of its files sorted by path, so file order never changes it.

import { createHash } from "node:crypto";
import { type SkillFile, skillHashInput } from "@deskmates/contracts";

export function skillContentHash(files: readonly SkillFile[]): string {
  return createHash("sha256").update(skillHashInput(files)).digest("hex");
}
