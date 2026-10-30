// T1, issue #21: the forward-only migration gives existing forced credentials a reason without
// forcing accounts whose password was self-set.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "../db/migrate.js";

const MIGRATION = "202610181808-password-change-provenance.sql";
const SOURCE = fileURLToPath(new URL("../../migrations/", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the password-change provenance migration (issue #21)", () => {
  it("backfills the protected default and leaves self-set passwords unforced", () => {
    const dir = mkdtempSync(join(tmpdir(), "password-change-"));
    dirs.push(dir);
    const files = listMigrationFiles(SOURCE);
    expect(files).toContain(MIGRATION);
    for (const name of files.filter((name) => name < MIGRATION))
      copyFileSync(join(SOURCE, name), join(dir, name));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, dir);
    db.exec(`
      INSERT INTO users (id, display_name, created_at, updated_at)
        VALUES ('usr_forced', 'Forced', 't', 't'), ('usr_self', 'Self', 't', 't');
      INSERT INTO user_logins (id, user_id, provider, issuer, subject, created_at)
        VALUES ('aid_forced', 'usr_forced', 'local', 'local', 'forced', 't'),
               ('aid_self', 'usr_self', 'local', 'local', 'self', 't');
      INSERT INTO local_credentials (login_id, password_hash, must_change, updated_at)
        VALUES ('aid_forced', '$argon2id$forced', 1, 't'),
               ('aid_self', '$argon2id$self', 0, 't');
    `);

    copyFileSync(join(SOURCE, MIGRATION), join(dir, MIGRATION));
    expect(applyMigrations(db, dir)).toEqual([MIGRATION]);
    expect(
      db
        .prepare(
          "SELECT login_id, must_change, password_change_reason FROM local_credentials ORDER BY login_id",
        )
        .all(),
    ).toEqual([
      { login_id: "aid_forced", must_change: 1, password_change_reason: "default" },
      { login_id: "aid_self", must_change: 0, password_change_reason: null },
    ]);
  });
});
