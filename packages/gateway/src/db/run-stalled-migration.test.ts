// T1, issue #9: the run-stalled-status migration rebuilds `runs` to admit `stalled` and keeps every
// row, key, index, trigger and dependent row as it was. Applied to a database migrated up to the
// migration before it.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "./migrate.js";

const MIGRATION = "202610151800-run-stalled-status.sql";
const SOURCE = fileURLToPath(new URL("../../migrations/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function schemaOf(db: Database.Database, sql: string): string[] {
  return (db.prepare(sql).all() as { sql: string | null }[]).map((r) =>
    (r.sql ?? "").replace(/\s+/g, " "),
  );
}

const RUN_OBJECTS = `SELECT name AS sql FROM sqlite_master
  WHERE (tbl_name = 'runs' AND type IN ('index', 'trigger'))
     OR (type = 'trigger' AND sql LIKE '%FROM runs%') ORDER BY name`;

describe("the run-stalled-status migration (issue #9)", () => {
  it("admits stalled, keeps rows, children, indexes and triggers", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-stalled-"));
    dirs.push(dir);
    const files = listMigrationFiles(SOURCE);
    expect(files).toContain(MIGRATION);
    for (const name of files.filter((name) => name < MIGRATION))
      copyFileSync(join(SOURCE, name), join(dir, name));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, dir);
    db.exec(
      "INSERT INTO workspaces (id,tenant_id,name,sandbox_provider,status,created_at) VALUES ('w','tnt_default','w','docker','ready','t');" +
        "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('b','b','r','w','t');" +
        "INSERT INTO threads (id,workspace_id,kind,channel,title,turn_budget,status,created_at,updated_at) VALUES ('th','w','chat','web','',8,'active','t','t');" +
        `INSERT INTO runs (id,workspace_id,bot_id,thread_id,lane,trigger_kind,trigger_ref,status,config_json,resume_payload_json,created_at,started_at) VALUES ('r','w','b','th','interactive','thread_message','m','running','{"runType":"x"}','{"approvalId":"apr_1"}','t','t2');` +
        "INSERT INTO run_events (run_id,seq,attempt,kind,payload_json,ts) VALUES ('r',1,1,'log','{}','t')",
    );
    expect(() => db.prepare("UPDATE runs SET status = 'stalled' WHERE id = 'r'").run()).toThrow(
      /CHECK/,
    );
    const before = schemaOf(db, RUN_OBJECTS);

    copyFileSync(join(SOURCE, MIGRATION), join(dir, MIGRATION));
    expect(applyMigrations(db, dir)).toEqual([MIGRATION]);

    expect(schemaOf(db, RUN_OBJECTS)).toEqual(before);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      db
        .prepare("SELECT status, run_type, resume_approval_id, started_at FROM runs WHERE id = 'r'")
        .get(),
    ).toEqual({ status: "running", run_type: "x", resume_approval_id: "apr_1", started_at: "t2" });
    db.prepare("UPDATE runs SET status = 'stalled' WHERE id = 'r'").run();
    expect(() => db.prepare("UPDATE runs SET status = 'bogus' WHERE id = 'r'").run()).toThrow(
      /CHECK/,
    );
    // The child row still points at its run, and the cascade still reaches it.
    expect(db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id = 'r'").get()).toEqual({
      n: 1,
    });
    // The approval trigger reads the rebuilt table.
    db.exec(
      "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('b2','b2','r','w','t')",
    );
    const approval = db.prepare(
      "INSERT INTO approvals (id, workspace_id, run_id, bot_id, kind, action_json, risk_level, wait_mode, created_at) VALUES (?, 'w', 'r', ?, 'tool', '{}', 'L2', 'live', 't')",
    );
    expect(() => approval.run("a1", "b2")).toThrow(/approval bot differs from its run/);
    expect(() => approval.run("a2", "b")).not.toThrow();
    db.prepare("DELETE FROM runs WHERE id = 'r'").run();
    expect(db.prepare("SELECT count(*) AS n FROM run_events").get()).toEqual({ n: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
