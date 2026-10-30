// T1, issue #39 item 7: the model-job trigger kind migration adds `model_job` to the
// `run_trigger_kinds` lookup, so a run row of that kind is refused before it and accepted after
// it, and it rewrites no earlier run.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "./migrate.js";

const MIGRATION = "202610191500-model-job-trigger-kind.sql";
const SOURCE = fileURLToPath(new URL("../../migrations/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SEED =
  "INSERT INTO workspaces (id,tenant_id,name,sandbox_provider,status,created_at) VALUES ('w','tnt_default','w','docker','ready','t');" +
  "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('b','b','r','w','t');" +
  `INSERT INTO runs (id,workspace_id,bot_id,lane,trigger_kind,trigger_ref,status,config_json,created_at) VALUES ('old','w','b','background','cron','approval_review:apr_1','succeeded','{"runType":"approval_review"}','t');`;

function insertJob(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO runs (id,workspace_id,bot_id,lane,trigger_kind,trigger_ref,status,config_json,created_at)
     VALUES (?,'w','b','background','model_job','round_triage:m','queued','{}','t')`,
  ).run(id);
}

describe("the model-job trigger kind migration (issue #39 item 7)", () => {
  it("admits model_job runs and leaves earlier rows as they were", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-job-trigger-"));
    dirs.push(dir);
    const files = listMigrationFiles(SOURCE);
    expect(files).toContain(MIGRATION);
    for (const name of files.filter((name) => name < MIGRATION))
      copyFileSync(join(SOURCE, name), join(dir, name));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, dir);
    db.exec(SEED);
    expect(() => insertJob(db, "before")).toThrow(/FOREIGN KEY/);

    copyFileSync(join(SOURCE, MIGRATION), join(dir, MIGRATION));
    applyMigrations(db, dir);
    insertJob(db, "after");
    expect(db.prepare("SELECT id, trigger_kind FROM runs ORDER BY id").all()).toEqual([
      { id: "after", trigger_kind: "model_job" },
      { id: "old", trigger_kind: "cron" },
    ]);
  });
});
