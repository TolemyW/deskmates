// T1: restoring across the schema baseline (ADR-0031 decision 3). A backup this binary would
// refuse to open is refused before the current database is moved aside.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase, manifestPath, restoreDatabase } from "./backup.js";
import { openDatabase } from "./open.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-restore-"));
  dirs.push(dir);
  return dir;
}

/** A backup whose manifest lists the given migrations, with a matching hash. */
function fakeBackup(dir: string, migrations: string[]): string {
  const path = join(dir, "old.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.close();
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(
    manifestPath(path),
    JSON.stringify({ kind: "deskmates-gateway-backup", sha256, migrations, tables: {} }),
  );
  return path;
}

describe("restore across the baseline (ADR-0031 decision 3)", () => {
  it("refuses a pre-baseline backup and leaves the target in place", () => {
    const dir = workDir();
    const target = join(dir, "gateway.db");
    openDatabase(target).close();
    const before = readFileSync(target);
    const backup = fakeBackup(dir, [
      "0001-init.sql",
      "0056-workspace-restoration-requirements.sql",
    ]);
    expect(() => restoreDatabase(backup, target)).toThrow(/before the schema baseline/);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it("refuses a backup from a newer Gateway and leaves the target in place", () => {
    const dir = workDir();
    const target = join(dir, "gateway.db");
    openDatabase(target).close();
    const backup = fakeBackup(dir, ["299912312359-from-the-future.sql"]);
    expect(() => restoreDatabase(backup, target)).toThrow(/newer Gateway/);
    expect(existsSync(target)).toBe(true);
  });

  it("restores a baseline backup", async () => {
    const dir = workDir();
    const source = join(dir, "source.db");
    openDatabase(source).close();
    const backup = join(dir, "backup.sqlite");
    await backupDatabase(source, backup);
    const target = join(dir, "gateway.db");
    const result = restoreDatabase(backup, target);
    expect(result.previous).toBeNull();
    expect(existsSync(target)).toBe(true);
  });
});
