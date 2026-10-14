// Forward-only migrations: every file in `migrations/` is applied once, in filename order, inside
// its own transaction, and recorded by name in `schema_migrations` (ADR-0030).
//
// Names: every migration is `YYYYMMDDHHmm-name.sql` (UTC authoring time). The first is the schema
// baseline (ADR-0031), which replaced the legacy `NNNN-name.sql` files; never rename or edit a
// migration that has merged: its name is its identity in every database and backup.
//
// Refusals, all before anything is applied:
// - a database created by the legacy migrations, or holding tables but no `schema_migrations`,
//   predates the baseline and is never upgraded or wiped (ADR-0031 decision 2);
// - a database holding a name this binary does not know was migrated by a newer Gateway;
// - a pending migration that sorts before the newest applied one would run out of order.
// `scripts/check-migration-order.mjs` catches the last in CI.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** `YYYYMMDDHHmm-slug.sql`. */
const MIGRATION_NAME =
  /^2\d{3}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d-[a-z0-9-]+\.sql$/;

/** A name written by the legacy migrations replaced by the baseline (ADR-0031). */
const LEGACY_NAME = /^0\d{3}-[a-z0-9-]+\.sql$/;

/**
 * A migration that rebuilds a table other tables reference declares it on its first line. SQLite
 * runs ON DELETE actions and foreign key checks during DROP TABLE even inside a transaction, so
 * such a migration runs with enforcement off and verifies every relation before it commits.
 */
export const FOREIGN_KEYS_OFF_HEADER = "-- deskmates:foreign-keys-off";

export const PRE_BASELINE_MESSAGE =
  "database was created before the schema baseline (ADR-0031); this release starts only on an empty database. Nothing was changed; restore it with the release that wrote it";

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => MIGRATION_NAME.test(f))
    .sort();
}

/** Throws when the database predates the baseline: legacy names, or tables but no ledger. */
export function assertNotPreBaseline(db: Database.Database): void {
  const hasLedger =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined;
  if (!hasLedger) {
    const tables = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get() as { n: number };
    if (tables.n > 0) throw new Error(PRE_BASELINE_MESSAGE);
    return;
  }
  const names = (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
    (r) => r.name,
  );
  assertNamesNotPreBaseline(names);
}

/** The same check over a list of applied names (a backup manifest). */
export function assertNamesNotPreBaseline(names: readonly string[]): void {
  if (names.some((name) => LEGACY_NAME.test(name))) throw new Error(PRE_BASELINE_MESSAGE);
}

/** Applies pending migrations and returns the names applied in this call (empty when up to date). */
export function applyMigrations(db: Database.Database, dir: string = MIGRATIONS_DIR): string[] {
  assertNotPreBaseline(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  // A database migrated by a newer Gateway may hold data this binary cannot guard
  // (ADR-0022 MIG-05): refuse it instead of serving it. Restore a backup taken before the upgrade.
  const known = new Set(listMigrationFiles(dir));
  const unknown = [...applied].filter((name) => !known.has(name)).sort();
  if (unknown.length > 0)
    throw new Error(
      `database was migrated by a newer Gateway (${unknown.join(", ")}); do not downgrade, restore a backup instead`,
    );
  // Two branches that each added a migration may merge in either order. Applying the one that
  // sorts earlier after the later one already ran is an order no developer tested (ADR-0030).
  const newest = [...applied].sort().at(-1);
  const late = newest ? [...known].filter((name) => !applied.has(name) && name < newest) : [];
  if (newest && late.length > 0)
    throw new Error(
      `pending migration ${late.sort().join(", ")} sorts before the newest applied migration ${newest}; re-timestamp it after ${newest} instead of applying it out of order`,
    );
  const record = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  const done: string[] = [];
  for (const name of listMigrationFiles(dir)) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    const foreignKeysOff = sql.split("\n", 1)[0]?.trim() === FOREIGN_KEYS_OFF_HEADER;
    const foreignKeys = foreignKeysOff
      ? (db.pragma("foreign_keys", { simple: true }) as number)
      : undefined;
    if (foreignKeysOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        if (foreignKeysOff) {
          const violations = db.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0)
            throw new Error(`${name} leaves ${violations.length} foreign key violation(s)`);
        }
        record.run(name, new Date().toISOString());
      })();
    } finally {
      if (foreignKeysOff) db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
    done.push(name);
  }
  return done;
}
