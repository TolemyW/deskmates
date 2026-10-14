import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_EVENT_KINDS } from "@deskmates/contracts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { QUEUED_RUNS_SQL } from "../ledger/runs.js";
import { FOREIGN_KEYS_OFF_HEADER, applyMigrations, listMigrationFiles } from "./migrate.js";

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

const DESIGN_TABLES = [
  "workspaces",
  "browser_locks",
  "bots",
  "threads",
  "thread_pins",
  "thread_members",
  "thread_messages",
  "bot_sessions",
  "runs",
  "run_usage",
  "prices",
  "run_events",
  "approvals",
  "approval_rules",
  "egress_rules",
  "knowledge_docs",
  "connectors",
  "secrets",
];

/** One workspace, bot, thread and run, the fixture most schema checks start from. */
function seeded(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  db.exec(
    "INSERT INTO workspaces (id,tenant_id,name,sandbox_provider,status,created_at) VALUES ('w','tnt_default','w','docker','ready','t');" +
      "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('b','b','r','w','t');" +
      "INSERT INTO threads (id,workspace_id,kind,channel,title,turn_budget,status,created_at,updated_at) VALUES ('th','w','chat','web','',8,'active','t','t');" +
      "INSERT INTO runs (id,workspace_id,bot_id,thread_id,lane,trigger_kind,trigger_ref,status,created_at) VALUES ('r','w','b','th','background','cron','c','running','t')",
  );
  return db;
}

describe("the schema baseline (ADR-0031)", () => {
  it("applies the baseline to an empty database and creates every design §4 table", () => {
    const db = new Database(":memory:");
    const applied = applyMigrations(db);
    expect(applied).toEqual(listMigrationFiles());
    expect(applied[0]).toMatch(/^\d{12}-baseline\.sql$/);
    const names = tableNames(db);
    for (const t of DESIGN_TABLES) expect(names, `missing table ${t}`).toContain(t);
    expect(names).toContain("schema_migrations");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("holds no legacy migration file (decision 1)", () => {
    const dir = new URL("../../migrations/", import.meta.url);
    expect(listMigrationFiles().some((name) => /^0\d{3}-/.test(name))).toBe(false);
    expect(readFileSync(new URL(listMigrationFiles()[0] ?? "", dir), "utf8")).toContain("ADR-0031");
  });

  it("is a no-op when applied twice", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const before = tableNames(db);
    expect(applyMigrations(db)).toEqual([]);
    expect(tableNames(db)).toEqual(before);
    const rows = db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number };
    expect(rows.n).toBe(listMigrationFiles().length);
  });

  it("names nothing identity-like (ADR-0004 item 4)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as { sql: string }[]
    )
      .map((r) => r.sql)
      .join("\n");
    expect(ddl).not.toMatch(/identity/i);
  });

  it("the scheduler's queued-runs query uses an index, not a scan of `runs`", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${QUEUED_RUNS_SQL}`).all() as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan.join(" | ")).toContain("runs_status_created");
    expect(plan.join(" | ")).not.toContain("SCAN runs");
  });

  it("keys run_events redelivery on (run, attempt, sidecar_seq) and run_usage on (run, attempt, model)", () => {
    const db = seeded();
    const event = db.prepare(
      "INSERT INTO run_events (run_id,seq,kind,payload_json,ts,sidecar_seq,attempt) VALUES ('r',?,'log','{}','t',?,?)",
    );
    event.run(1, 1, 2);
    expect(() => event.run(2, 1, 2)).toThrow();
    expect(() => event.run(3, 1, 3)).not.toThrow();
    const usage = db.prepare(
      "INSERT INTO run_usage (run_id, attempt, model, input_tokens) VALUES ('r', ?, 'm', ?)",
    );
    expect(() => usage.run(1, 100)).not.toThrow();
    expect(() => usage.run(2, 60)).not.toThrow();
    expect(() => usage.run(2, 70)).toThrow();
  });

  it("run_events accepts every RunEventKind from its lookup table and nothing else", () => {
    const db = seeded();
    const insert = db.prepare(
      "INSERT INTO run_events (run_id,seq,kind,payload_json,ts) VALUES ('r',?,?,'{}','t')",
    );
    RUN_EVENT_KINDS.forEach((kind, i) => {
      expect(() => insert.run(10 + i, kind), kind).not.toThrow();
    });
    expect(() => insert.run(99, "bogus")).toThrow(/FOREIGN KEY/);
    // A new kind is one INSERT into the lookup table, never a rebuild (decision 5).
    db.prepare("INSERT INTO run_event_kinds (kind) VALUES ('new_kind')").run();
    expect(() => insert.run(100, "new_kind")).not.toThrow();
  });

  it("model_requests stores hashes and nullable token counts, one seq per run", () => {
    const db = seeded();
    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'model_requests'").get() as {
        sql: string;
      }
    ).sql;
    expect(ddl).toContain("system_sha256");
    expect(ddl).not.toMatch(/system_(text|prompt)\b/);
    const insert = db.prepare(
      "INSERT INTO model_requests (run_id,attempt,seq,ts,request_kind,stream) VALUES ('r',1,?,'t',?,0)",
    );
    expect(() => insert.run(1, "messages")).not.toThrow();
    expect(() => insert.run(1, "messages")).toThrow();
    expect(() => insert.run(2, "other")).toThrow();
    expect(db.prepare("SELECT thinking_tokens FROM model_requests").get()).toEqual({
      thinking_tokens: null,
    });
  });

  it("runs.status accepts silent and rejects unknown states; trigger kinds come from a lookup", () => {
    const db = seeded();
    const insert = db.prepare(
      "INSERT INTO runs (id,workspace_id,bot_id,lane,trigger_kind,trigger_ref,status,created_at) VALUES (?,'w','b','interactive',?,'m',?,'t')",
    );
    expect(() => insert.run("r1", "thread_message", "silent")).not.toThrow();
    expect(() => insert.run("r2", "welcome", "queued")).not.toThrow();
    expect(() => insert.run("r3", "thread_message", "bogus")).toThrow();
    expect(() => insert.run("r4", "bogus", "queued")).toThrow(/FOREIGN KEY/);
  });

  it("a run's bot and thread must be in the run's workspace (composite keys)", () => {
    const db = seeded();
    db.exec(
      "INSERT INTO workspaces (id,tenant_id,name,sandbox_provider,status,created_at) VALUES ('w2','tnt_default','w2','docker','ready','t');" +
        "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('b2','b2','r','w2','t')",
    );
    const insert = db.prepare(
      "INSERT INTO runs (id,workspace_id,bot_id,thread_id,lane,trigger_kind,trigger_ref,status,created_at) VALUES (?,?,?,?,'interactive','cron','c','queued','t')",
    );
    expect(() => insert.run("x1", "w2", "b2", "th")).toThrow(/FOREIGN KEY/);
    expect(() => insert.run("x2", "w", "b2", null)).toThrow(/FOREIGN KEY/);
    expect(() => insert.run("x3", "w2", "b2", null)).not.toThrow();
  });

  it("exposes the JSON fields the Gateway filters on as generated columns", () => {
    const db = seeded();
    db.prepare("UPDATE runs SET config_json = ?, resume_payload_json = ? WHERE id = 'r'").run(
      JSON.stringify({ runType: "memory_consolidation", continuationExpiresAt: "x" }),
      JSON.stringify({ approvalId: "a1" }),
    );
    expect(
      db
        .prepare(
          "SELECT run_type, continuation_expires_at, resume_approval_id FROM runs WHERE id = 'r'",
        )
        .get(),
    ).toEqual({
      run_type: "memory_consolidation",
      continuation_expires_at: "x",
      resume_approval_id: "a1",
    });
    db.prepare(
      "INSERT INTO run_events (run_id,seq,kind,payload_json,ts) VALUES ('r',1,'log',?,'t')",
    ).run(JSON.stringify({ source: "usage_final" }));
    expect(db.prepare("SELECT source FROM run_events").get()).toEqual({ source: "usage_final" });
  });

  it("a workspace without a tenant is refused, never filled in", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO workspaces (id,name,sandbox_provider,status,created_at) VALUES ('w','w','docker','ready','t')",
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });
});

/** Writes a migration that creates a table named after the file. */
function writeMigration(dir: string, name: string, header = ""): void {
  const table = name.replace(/\.sql$/, "").replace(/[^a-z0-9]/g, "_");
  writeFileSync(join(dir, name), `${header}CREATE TABLE t_${table} (id INTEGER);`);
}

function fixtureDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-migration-order-"));
  for (const name of names) writeMigration(dir, name);
  return dir;
}

function appliedNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]
  ).map((r) => r.name);
}

describe("migration identifiers (ADR-0030)", () => {
  it("accepts timestamped names only, in order", () => {
    const dir = fixtureDir([
      "202610131420-task-labels.sql",
      "0001-init.sql",
      "202610121000-earlier.sql",
      "00012-five-digits.sql",
      "2026101314-short.sql",
      "202610131420-Upper.sql",
      "202610131420_underscore.sql",
      "0003-notes.txt",
    ]);
    try {
      expect(listMigrationFiles(dir)).toEqual([
        "202610121000-earlier.sql",
        "202610131420-task-labels.sql",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies in-order in two steps", () => {
    const dir = fixtureDir(["202610121000-first.sql"]);
    const db = new Database(":memory:");
    try {
      expect(applyMigrations(db, dir)).toEqual(["202610121000-first.sql"]);
      writeMigration(dir, "202610131420-task-labels.sql");
      expect(applyMigrations(db, dir)).toEqual(["202610131420-task-labels.sql"]);
      expect(tableNames(db)).toContain("t_202610131420_task_labels");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an out-of-order pending migration, names both and applies nothing", () => {
    const dir = fixtureDir(["202610121000-first.sql", "202610131420-newest.sql"]);
    const db = new Database(":memory:");
    try {
      applyMigrations(db, dir);
      writeMigration(dir, "202610131419-late.sql");
      writeMigration(dir, "202610131500-after.sql");
      expect(() => applyMigrations(db, dir)).toThrow(
        /202610131419-late\.sql.*202610131420-newest\.sql/,
      );
      expect(appliedNames(db)).toEqual(["202610121000-first.sql", "202610131420-newest.sql"]);
      expect(tableNames(db)).not.toContain("t_202610131500_after");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still refuses a database migrated by a newer Gateway", () => {
    const dir = fixtureDir(["202610121000-first.sql", "202610131420-newest.sql"]);
    const db = new Database(":memory:");
    try {
      applyMigrations(db, dir);
      rmSync(join(dir, "202610131420-newest.sql"));
      expect(() => applyMigrations(db, dir)).toThrow(
        /newer Gateway \(202610131420-newest\.sql\); do not downgrade/,
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pre-baseline databases (ADR-0031 decision 2)", () => {
  function fileBytes(path: string): Buffer {
    return readFileSync(path);
  }

  it("refuses a pre-baseline database without touching it", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-pre-baseline-"));
    const path = join(dir, "gateway.db");
    try {
      const legacy = new Database(path);
      legacy.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);" +
          "INSERT INTO schema_migrations VALUES ('0001-init.sql', 't');" +
          "CREATE TABLE workspaces (id TEXT PRIMARY KEY)",
      );
      legacy.close();
      const before = fileBytes(path);
      const db = new Database(path);
      expect(() => applyMigrations(db)).toThrow(/before the schema baseline/);
      db.close();
      expect(fileBytes(path).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unversioned non-empty database", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE something (id INTEGER)");
    expect(() => applyMigrations(db)).toThrow(/before the schema baseline/);
    expect(tableNames(db)).toEqual(["something"]);
  });
});

describe("migration failure (ADR-0022 MIG-02)", () => {
  it.each(["start", "end"])(
    "the baseline failing at its %s rolls back completely and then applies once",
    (where) => {
      const source = new URL("../../migrations/", import.meta.url);
      const baseline = listMigrationFiles()[0] ?? "";
      const sql = readFileSync(new URL(baseline, source), "utf8");
      const fail = "INSERT INTO migration_failure_injected_here_no_such_table VALUES (1);";
      const dir = mkdtempSync(join(tmpdir(), "deskmates-mig02-"));
      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      try {
        writeFileSync(
          join(dir, baseline),
          where === "start" ? `${fail}\n${sql}` : `${sql}\n${fail}`,
        );
        expect(() => applyMigrations(db, dir)).toThrow(/no such table/);
        expect(tableNames(db)).toEqual(["schema_migrations"]);
        writeFileSync(join(dir, baseline), sql);
        expect(applyMigrations(db, dir)).toEqual([baseline]);
        expect(applyMigrations(db, dir)).toEqual([]);
        expect(db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("foreign-keys-off migrations (ADR-0031 decision 4)", () => {
  it("honours the foreign-keys-off header and restores enforcement", () => {
    const dir = fixtureDir(["202610121000-first.sql"]);
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      applyMigrations(db, dir);
      writeFileSync(
        join(dir, "202610131420-rebuild.sql"),
        `${FOREIGN_KEYS_OFF_HEADER}\nCREATE TABLE seen (fk INTEGER);\nINSERT INTO seen SELECT foreign_keys FROM pragma_foreign_keys;`,
      );
      writeFileSync(
        join(dir, "202610131430-plain.sql"),
        "CREATE TABLE seen2 (fk INTEGER);\nINSERT INTO seen2 SELECT foreign_keys FROM pragma_foreign_keys;",
      );
      applyMigrations(db, dir);
      expect(db.prepare("SELECT fk FROM seen").get()).toEqual({ fk: 0 });
      expect(db.prepare("SELECT fk FROM seen2").get()).toEqual({ fk: 1 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
