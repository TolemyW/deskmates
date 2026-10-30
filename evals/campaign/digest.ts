// A content digest for generated task material. The task files record the digest of what the
// generators produce; a validator recomputes it, so a change to a generator cannot silently
// change a frozen task set (benchmark §8: changing a task bumps the version).

import { createHash } from "node:crypto";

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
