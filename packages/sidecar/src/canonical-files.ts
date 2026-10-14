// ADR-0011 A5: restore operator-owned files before context assembly, then audit changes.
// These files remain readable/writable by every bot in the workspace; this is not isolation.
import { createHash } from "node:crypto";
import type { SidecarFs } from "./deps.js";
import { redactText } from "./redact.js";

export interface CanonicalFileBody {
  body: string;
  version: string;
}

export interface CanonicalFileSnapshot {
  path: string;
  fileName: "SOUL.md" | "MEMORY.md";
  body: string;
  version: string;
  /** Peer snapshots detect changes but do not claim that an unmigrated peer is restored. */
  peer?: boolean;
  existed?: boolean;
}

interface CanonicalFilesRequest {
  botHomeDir: string;
  canonicalFiles?: { soul?: CanonicalFileBody; memory?: CanonicalFileBody };
}

function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Undefined means an old deployment has not migrated the file; leave its bytes untouched. */
export async function prepareCanonicalFiles(
  request: CanonicalFilesRequest,
  fs: SidecarFs,
): Promise<CanonicalFileSnapshot[]> {
  if (!request.canonicalFiles) return [];
  if (!/^\/home\/[A-Za-z0-9_-]+$/.test(request.botHomeDir)) {
    throw new Error("Canonical bot files require a valid bot home");
  }
  const snapshots: CanonicalFileSnapshot[] = [];
  for (const [key, fileName] of [
    ["soul", "SOUL.md"],
    ["memory", "MEMORY.md"],
  ] as const) {
    const file = request.canonicalFiles[key];
    if (!file) continue;
    if (digest(file.body) !== file.version) throw new Error("Canonical file version mismatch");
    snapshots.push({ path: `${request.botHomeDir}/${fileName}`, fileName, ...file });
  }
  // Validate all bodies before writing any; a malformed request cannot partially replace files.
  for (const snapshot of snapshots) await fs.writeFile(snapshot.path, snapshot.body);
  return snapshots;
}

/** Observe peers without rewriting their files while another bot may be running. */
export async function snapshotPeerRuleFiles(
  homeDirs: readonly string[],
  fs: SidecarFs,
): Promise<CanonicalFileSnapshot[]> {
  const snapshots: CanonicalFileSnapshot[] = [];
  for (const home of new Set(homeDirs)) {
    if (!/^\/home\/[A-Za-z0-9_-]+$/.test(home)) throw new Error("Invalid peer bot home");
    for (const fileName of ["SOUL.md", "MEMORY.md"] as const) {
      const path = `${home}/${fileName}`;
      const existed = await fs.exists(path);
      const body = existed ? await fs.readFile(path) : "";
      snapshots.push({ path, fileName, body, version: digest(body), peer: true, existed });
    }
  }
  return snapshots;
}

/** Keep changed content bounded and redact before truncation so tokens are never split first. */
function changedLines(before: string, after: string, secrets: readonly string[]): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const diff = [
    ...oldLines.slice(prefix, oldEnd).map((line) => `- ${line}`),
    ...newLines.slice(prefix, newEnd).map((line) => `+ ${line}`),
  ].join("\n");
  const redacted = redactText(diff, secrets);
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}\n[diff truncated]` : redacted;
}

/** Audit failures become diagnostics, never a reason to discard the run's completed usage. */
export async function auditCanonicalFiles(
  snapshots: readonly CanonicalFileSnapshot[],
  fs: SidecarFs,
  secrets: readonly string[] = [],
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for (const snapshot of snapshots) {
    try {
      const body = await fs.readFile(snapshot.path);
      const actualVersion = digest(body);
      if (actualVersion === snapshot.version && snapshot.existed !== false) continue;
      events.push({
        fileName: snapshot.fileName,
        path: snapshot.path,
        expectedVersion: snapshot.version,
        actualVersion,
        reason: snapshot.existed === false ? "file_created" : "content_changed",
        diff: changedLines(snapshot.body, body, secrets),
        restoredOnNextRun: !snapshot.peer,
        ...(snapshot.peer ? { observation: "peer_file_changed_during_run" } : {}),
      });
    } catch {
      if (snapshot.existed === false) continue;
      events.push({
        fileName: snapshot.fileName,
        path: snapshot.path,
        expectedVersion: snapshot.version,
        reason: "missing_or_unreadable",
        restoredOnNextRun: !snapshot.peer,
      });
    }
  }
  return events;
}
