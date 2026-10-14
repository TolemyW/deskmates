import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { backupTestLedger } from "./ledger-backup.js";

const dirs: string[] = [];
const handles: Database.Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-ledger-backup-"));
  dirs.push(dir);
  const path = join(dir, "source.sqlite");
  const database = new Database(path);
  handles.push(database);
  database.pragma("journal_mode = WAL");
  database.exec("CREATE TABLE usage (tokens INTEGER); INSERT INTO usage VALUES (7)");
  return { dir, path, database, target: join(dir, "saved.sqlite") };
}
function tokens(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT tokens FROM usage ORDER BY tokens").pluck().all();
  } finally {
    db.close();
  }
}

it("includes uncheckpointed WAL rows and leaves the original writer open", async () => {
  const f = fixture();
  expect(statSync(`${f.path}-wal`).size).toBeGreaterThan(0);
  expect(await backupTestLedger(f.database, f.path, f.target)).toEqual({
    status: "saved",
    mode: "open_handle",
    reason: null,
  });
  expect(tokens(f.target)).toEqual([7]);
  expect(f.database.open).toBe(true);
  expect(statSync(f.target).mode & 0o777).toBe(0o600);
});

it("reads the latest ledger after the original app closed and another app wrote WAL rows", async () => {
  const f = fixture();
  f.database.close();
  const restarted = new Database(f.path);
  handles.push(restarted);
  restarted.exec("INSERT INTO usage VALUES (11)");
  expect(await backupTestLedger(f.database, f.path, f.target)).toEqual({
    status: "saved",
    mode: "reopened_readonly",
    reason: null,
  });
  expect(tokens(f.target)).toEqual([7, 11]);
  expect(restarted.open).toBe(true);
  expect(tokens(f.path)).toEqual([7, 11]);
});

it("preserves a previous receipt instead of overwriting it", async () => {
  const f = fixture();
  writeFileSync(f.target, "previous receipt");
  expect(await backupTestLedger(f.database, f.path, f.target)).toMatchObject({
    status: "unavailable",
    reason: "output_unavailable",
  });
  expect(readFileSync(f.target, "utf8")).toBe("previous receipt");
});

it("reports a missing closed source as unavailable without creating a replacement database", async () => {
  const f = fixture();
  f.database.close();
  rmSync(f.path);
  expect(await backupTestLedger(f.database, f.path, f.target)).toEqual({
    status: "unavailable",
    mode: "unknown",
    reason: "source_unavailable",
  });
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(f.target)).toBe(false);
});
