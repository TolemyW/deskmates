import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVIDENCE_LOCK_STALE_MS,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  EVIDENCE_MAX_TOTAL_BYTES,
  EVIDENCE_TTL_MS,
  saveToolEvidence,
} from "./tool-evidence-store.js";
const roots: string[] = [];
async function root() {
  const p = await mkdtemp(join(tmpdir(), "evidence-"));
  roots.push(p);
  return p;
}
const txt = async (dir: string) => (await readdir(dir)).filter((n) => n.endsWith(".txt"));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
describe("bounded evidence cache", () => {
  it("bounds UTF-8 bytes and labels incomplete artifacts", async () => {
    const ref = await saveToolEvidence("😀".repeat(EVIDENCE_MAX_BYTES), { root: await root() });
    expect(ref.bytes).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
    expect(ref.truncated).toBe(true);
    expect(await readFile(ref.path, "utf8")).toContain("not complete evidence");
  });
  it("accepts a root below a symlinked ancestor (macOS /var -> /private/var)", async () => {
    const real = await root();
    const alias = join(await root(), "alias");
    await symlink(real, alias);
    const ref = await saveToolEvidence("fixture", { root: join(alias, "browser-evidence") });
    expect(ref.path.startsWith(join(alias, "browser-evidence"))).toBe(true);
    expect(await txt(join(real, "browser-evidence"))).toHaveLength(1);
  });
  it("expires old files on writes", async () => {
    const dir = await root();
    const first = await saveToolEvidence("old", { root: dir });
    await utimes(first.path, new Date(0), new Date(0));
    await saveToolEvidence("new", { root: dir, now: EVIDENCE_TTL_MS + 1 });
    await expect(readFile(first.path)).rejects.toThrow();
  });
  it("evicts oldest files by bytes, not by a small file count", async () => {
    expect(EVIDENCE_MAX_TOTAL_BYTES).toBe(32 * 1024 * 1024);
    expect(EVIDENCE_MAX_FILES).toBeGreaterThan(EVIDENCE_MAX_TOTAL_BYTES / EVIDENCE_MAX_BYTES);
    const dir = await root();
    const limits = { maxTotalBytes: 1000, maxFiles: 100 };
    const first = await saveToolEvidence("a".repeat(400), { root: dir, ...limits });
    await utimes(first.path, new Date(1000), new Date(1000));
    await saveToolEvidence("b".repeat(400), { root: dir, ...limits });
    // 400 + 400 + 400 > 1000: only the oldest goes.
    await saveToolEvidence("c".repeat(400), { root: dir, ...limits });
    expect(await txt(dir)).toHaveLength(2);
    await expect(readFile(first.path)).rejects.toThrow();
    // Many small files stay well past 128 when bytes allow it.
    for (let i = 0; i < 150; i++) await saveToolEvidence("x", { root: dir, maxFiles: 4096 });
    expect((await txt(dir)).length).toBeGreaterThan(128);
  });
  it("keeps a file-count ceiling as a backstop", async () => {
    const dir = await root();
    for (let i = 0; i < 6; i++) await saveToolEvidence(String(i), { root: dir, maxFiles: 4 });
    expect(await txt(dir)).toHaveLength(4);
  });
  it("refuses a symlink root", async () => {
    const dir = await root();
    const alias = join(await root(), "alias");
    await symlink(dir, alias);
    await expect(saveToolEvidence("sensitive", { root: alias })).rejects.toThrow("Unsafe");
  });
  it("serializes concurrent writers with a bounded retry instead of failing them", async () => {
    const dir = await root();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => saveToolEvidence("fixture", { root: dir, maxFiles: 5 })),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await txt(dir)).toHaveLength(5);
  });
  it("breaks a lock left by a dead writer", async () => {
    const dir = await root();
    await mkdir(join(dir, ".writer"));
    // PID 2^22 + 1 is above Linux and macOS pid_max defaults: never a live process.
    await writeFile(
      join(dir, ".writer", "owner"),
      JSON.stringify({ pid: 4194305, at: Date.now() }),
    );
    await expect(saveToolEvidence("fixture", { root: dir })).resolves.toBeDefined();
  });
  it("breaks a lock older than the stale bound even when its owner is unknown", async () => {
    const dir = await root();
    await mkdir(join(dir, ".writer"));
    const old = new Date(Date.now() - EVIDENCE_LOCK_STALE_MS - 1000);
    await utimes(join(dir, ".writer"), old, old);
    await expect(saveToolEvidence("fixture", { root: dir })).resolves.toBeDefined();
  });
  it("gives up on a fresh lock held by a live writer", async () => {
    const dir = await root();
    await mkdir(join(dir, ".writer"));
    await writeFile(
      join(dir, ".writer", "owner"),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
    );
    await expect(saveToolEvidence("fixture", { root: dir, lockWaitMs: 50 })).rejects.toThrow(
      "busy",
    );
    expect(await txt(dir)).toHaveLength(0);
  });
});
