// T1, ADR-0047 decision 7: the migration that replaces `UNIQUE (workspace_id, plugin_id)` rebuilds
// `channel_connections` and keeps every existing (ABI-1) row as it was, at binding generation 1.
// Afterwards a single-connection plugin still holds one connection per workspace in the database,
// and an identity is unique per plugin across the installation.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "../db/migrate.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));
const THIS = "202610171104-channel-connection-identity.sql";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const at = "2026-10-17T00:00:00.000Z";

describe("the channel connection identity migration (ADR-0047)", () => {
  it("keeps existing connections and enforces both uniqueness rules afterwards", () => {
    const before = mkdtempSync(join(tmpdir(), "deskmates-migrations-"));
    dirs.push(before);
    for (const name of listMigrationFiles(MIGRATIONS).filter((n) => n < THIS))
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, before);
    const tenant = (db.prepare("SELECT id FROM tenants LIMIT 1").get() as { id: string }).id;
    db.prepare(
      "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws_a', ?, 'A', 'docker', 'ready', ?)",
    ).run(tenant, at);
    db.prepare(
      "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('bot_a', 'ws_a', 'alice', 'r', ?)",
    ).run(at);
    db.prepare(
      `INSERT INTO channel_connections (id, workspace_id, plugin_id, plugin_version, method, bot_id,
         config_json, phase, account, created_at, updated_at)
       VALUES ('chn_old', 'ws_a', 'whatsapp', '1.0.0', 'qr', 'bot_a', '{"allowedSenders":"1"}',
         'connected', '15550001111', ?, ?)`,
    ).run(at, at);

    // Only through this migration: the next one moves WhatsApp rows to ABI 2 (amendment 1).
    const through = mkdtempSync(join(tmpdir(), "deskmates-migrations-"));
    dirs.push(through);
    for (const name of listMigrationFiles(MIGRATIONS).filter((n) => n <= THIS))
      copyFileSync(join(MIGRATIONS, name), join(through, name));
    expect(applyMigrations(db, through)).toContain(THIS);
    expect(db.prepare("SELECT * FROM channel_connections").get()).toMatchObject({
      id: "chn_old",
      plugin_id: "whatsapp",
      api_version: 1,
      bot_id: "bot_a",
      config_json: '{"allowedSenders":"1"}',
      account: "15550001111",
      account_key: null,
      binding_generation: 1,
      credential_generation: 1,
      multiple_connections: 0,
    });
    const insert = db.prepare(
      `INSERT INTO channel_connections (id, workspace_id, plugin_id, plugin_version, api_version,
         method, bot_id, config_json, phase, account_key, multiple_connections, created_at,
         updated_at)
       VALUES (?, 'ws_a', ?, '1.0.0', ?, 'm', 'bot_a', '{}', 'connecting', ?, ?, ?, ?)`,
    );
    // A second single-connection WhatsApp row in the workspace is refused by the database.
    expect(() => insert.run("chn_dup", "whatsapp", 1, null, 0, at, at)).toThrow(/UNIQUE/);
    // Two identities of a multi-connection plugin coexist; the same identity twice does not.
    insert.run("chn_t1", "telegram", 2, "telegram:bot:1", 1, at, at);
    insert.run("chn_t2", "telegram", 2, "telegram:bot:2", 1, at, at);
    expect(() => insert.run("chn_t3", "telegram", 2, "telegram:bot:1", 1, at, at)).toThrow(
      /UNIQUE/,
    );
    // An ABI-2 row always carries its identity; an ABI-1 row never does.
    expect(() => insert.run("chn_t4", "telegram", 2, null, 1, at, at)).toThrow(/CHECK/);
    expect(() => insert.run("chn_w2", "whatsapp", 1, "whatsapp:x:1", 1, at, at)).toThrow(/CHECK/);
  });
});
