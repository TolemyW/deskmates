// Opens the connector's own SQLite file and applies its forward-only migrations
// (`packages/connector-postgres/migrations/NNNN-name.sql`), the same scheme as the Gateway's.
// `:memory:` is for tests.

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type ReceiptsDb = Database.Database;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

export function applyMigrations(db: ReceiptsDb, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const record = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  const done: string[] = [];
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-[a-z0-9-]+\.sql$/.test(f))
    .sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(name, new Date().toISOString());
    })();
    done.push(name);
  }
  return done;
}

export function openReceiptsDb(path: string): ReceiptsDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db);
  return db;
}
