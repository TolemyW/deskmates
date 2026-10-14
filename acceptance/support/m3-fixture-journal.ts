import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Reserve exact test resource names before Docker creates them, even if setup is interrupted. */
export function journalM3Fixture(kind: "container" | "network", name: string): void {
  const journal = process.env.M3_FIXTURE_JOURNAL;
  if (!journal || !isAbsolute(journal))
    throw Error("M3_FIXTURE_JOURNAL must be an absolute ownership journal path");
  appendFileSync(journal, `${JSON.stringify({ kind, name, at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
}
