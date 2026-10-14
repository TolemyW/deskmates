// Dedicated workspace evidence cache; downloads use the existing ADR-0014 authenticated route.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BROWSER_EVIDENCE_DIR,
  BROWSER_EVIDENCE_FILE,
  type ToolEvidenceReference,
} from "@deskmates/contracts";

export const EVIDENCE_MAX_BYTES = 256 * 1024;
/** Workspace quota. Eviction is by bytes so small artifacts keep their advertised lifetime. */
export const EVIDENCE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Backstop against directory bloat from many tiny artifacts; bytes are the real quota. */
export const EVIDENCE_MAX_FILES = 4096;
export const EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A writer holds the lock for milliseconds; one older than this crashed. */
export const EVIDENCE_LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

export interface EvidenceStoreOptions {
  root?: string;
  now?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  /** Longest a writer waits for a live peer before giving up. */
  lockWaitMs?: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the lock's owner died (sidecars share the workspace container's PID space) or
 *  the lock outlived any real write. A lock without a readable owner is judged by age only. */
async function stale(lock: string): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await lstat(lock)).mtimeMs;
  } catch {
    return false; // Released meanwhile: just retry.
  }
  if (Date.now() - mtimeMs > EVIDENCE_LOCK_STALE_MS) return true;
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner"), "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && Number.isInteger(owner.pid) && !alive(owner.pid);
  } catch {
    return false;
  }
}

async function acquire(lock: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }), {
        mode: 0o600,
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Two breakers can race on the same stale lock; the worst case is one write over quota,
    // corrected by the next write's eviction.
    if (await stale(lock)) {
      await rm(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error("Evidence cache busy");
    await sleep(Math.min(5 * 2 ** attempt, 100, Math.max(1, deadline - Date.now())));
  }
}

export async function saveToolEvidence(
  text: string,
  options: EvidenceStoreOptions = {},
): Promise<ToolEvidenceReference> {
  const {
    root = BROWSER_EVIDENCE_DIR,
    now = Date.now(),
    maxTotalBytes = EVIDENCE_MAX_TOTAL_BYTES,
    maxFiles = EVIDENCE_MAX_FILES,
    lockWaitMs = LOCK_WAIT_MS,
  } = options;
  await mkdir(root, { recursive: true, mode: 0o700 });
  // The root itself must be a real directory; a symlinked ancestor (/var -> /private/var on
  // macOS, a bind-mounted /work) is fine. Operate on the resolved path and require it to be
  // unchanged once the lock is held, so a swapped root cannot redirect writes or deletions.
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("Unsafe evidence directory");
  const real = await realpath(root);
  const lock = join(real, ".writer");
  await acquire(lock, lockWaitMs);
  try {
    const held = await lstat(root);
    if (
      held.isSymbolicLink() ||
      held.ino !== rootStat.ino ||
      held.dev !== rootStat.dev ||
      (await realpath(root)) !== real
    )
      throw new Error("Unsafe evidence directory");
    const raw = Buffer.from(text);
    const truncated = raw.length > EVIDENCE_MAX_BYTES;
    const marker = Buffer.from(
      "\n[truncated: full-result artifact exceeds 256 KiB; not complete evidence]\n",
    );
    const body = truncated
      ? Buffer.from(
          raw.subarray(0, EVIDENCE_MAX_BYTES - marker.length - 3).toString("utf8") +
            marker.toString(),
        )
      : raw;
    const files = [];
    for (const name of (await readdir(real)).filter((name) => BROWSER_EVIDENCE_FILE.test(name))) {
      const path = join(real, name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe evidence entry");
      if (now - stat.mtimeMs >= EVIDENCE_TTL_MS) await rm(path);
      else files.push({ path, time: stat.mtimeMs, bytes: stat.size });
    }
    files.sort((a, b) => a.time - b.time);
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    while (files.length > 0 && (files.length >= maxFiles || total + body.length > maxTotalBytes)) {
      const oldest = files.shift();
      if (!oldest) break;
      await rm(oldest.path);
      total -= oldest.bytes;
    }
    const name = `${randomUUID()}.txt`;
    const file = await open(
      join(real, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(body);
    } finally {
      await file.close();
    }
    return {
      path: join(root, name),
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      truncated,
      expiresAt: new Date(now + EVIDENCE_TTL_MS).toISOString(),
    };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
