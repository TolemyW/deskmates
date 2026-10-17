// T1, ADR-0002 amendment 6 D1 and D7: the approval-mode migration maps the old boolean (on to
// `automatic`, off to `manual`), drops it, moves an untouched 15-minute expiry to 60 and leaves an
// audited one alone. Applied to a database migrated up to the migration before it.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "../db/migrate.js";

const MIGRATION = "202610141132-workspace-approval-mode.sql";
const SOURCE = fileURLToPath(new URL("../../migrations/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the approval-mode migration (amendment 6)", () => {
  it("maps auto_approval, drops it and moves untouched 15-minute expiries to 60", () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-mode-"));
    dirs.push(dir);
    const files = listMigrationFiles(SOURCE);
    expect(files).toContain(MIGRATION);
    for (const name of files.filter((name) => name < MIGRATION))
      copyFileSync(join(SOURCE, name), join(dir, name));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, dir);
    const insert = db.prepare(
      "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at, auto_approval, approval_expiry_minutes) VALUES (?, 'tnt_default', ?, 'docker', 'ready', 't', ?, ?)",
    );
    insert.run("w_on", "on", 1, 15);
    insert.run("w_off", "off", 0, 15);
    insert.run("w_set15", "set15", 0, 15);
    insert.run("w_30", "thirty", 1, 30);
    db.prepare(
      "INSERT INTO audit_events (tenant_id, workspace_id, occurred_at, actor, action, target_kind, target_id) VALUES ('tnt_default', 'w_set15', 't', 'user:x', 'workspace.approval_expiry_set', 'workspace', 'w_set15')",
    ).run();

    copyFileSync(join(SOURCE, MIGRATION), join(dir, MIGRATION));
    expect(applyMigrations(db, dir)).toEqual([MIGRATION]);
    const rows = db
      .prepare("SELECT id, approval_mode, approval_expiry_minutes FROM workspaces ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "w_30", approval_mode: "automatic", approval_expiry_minutes: 30 },
      { id: "w_off", approval_mode: "manual", approval_expiry_minutes: 60 },
      { id: "w_on", approval_mode: "automatic", approval_expiry_minutes: 60 },
      { id: "w_set15", approval_mode: "manual", approval_expiry_minutes: 15 },
    ]);
    const columns = (db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(columns).not.toContain("auto_approval");
    // A new row gets the new default mode, and the mode is a closed set.
    db.prepare(
      "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('w_new', 'tnt_default', 'new', 'docker', 'ready', 't')",
    ).run();
    expect(db.prepare("SELECT approval_mode FROM workspaces WHERE id = 'w_new'").get()).toEqual({
      approval_mode: "automatic",
    });
    expect(() =>
      db.prepare("UPDATE workspaces SET approval_mode = 'everything' WHERE id = 'w_new'").run(),
    ).toThrow(/CHECK/);
    expect(
      db
        .prepare("SELECT 1 AS ok FROM audit_actions WHERE action = 'workspace.approval_mode_set'")
        .get(),
    ).toEqual({ ok: 1 });
  });
});
