// Opens the Gateway SQLite database and applies pending migrations. `:memory:` is for tests.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrate.js";

export type GatewayDb = Database.Database;

export function openDatabase(path: string): GatewayDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db);
  return db;
}
