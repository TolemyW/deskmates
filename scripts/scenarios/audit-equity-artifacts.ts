// Explicit offline audit. Does not submit tasks, fetch URLs, or modify captured files.
import { readFile } from "node:fs/promises";
import { auditEquityArtifacts } from "./artifact-validation.js";

async function main(): Promise<void> {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error("Usage: audit-equity-artifacts.ts <snapshot.json>");
  const bytes = await readFile(path);
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Snapshot exceeds 8 MiB");
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Snapshot must be UTF-8 JSON");
  }
  const audit = auditEquityArtifacts(snapshot);
  console.log(JSON.stringify(audit, null, 2));
  process.exitCode = audit.status === "structure-valid" ? 0 : 1;
}

main().catch((error: unknown) => {
  // Never print source contents, which can contain operator-supplied private text.
  console.error(error instanceof Error ? error.message : "Artifact audit failed");
  process.exitCode = 1;
});
