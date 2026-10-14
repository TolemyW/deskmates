// The schema conventions of ADR-0031 decision 5 and the workspace scope of decision 6, checked
// over the migrated schema itself, so a later migration that breaks one fails here.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AuditLog } from "../audit/audit-log.js";
import { applyMigrations } from "./migrate.js";

interface Column {
  name: string;
  type: string;
  notnull: number;
  hidden: number;
}
interface ForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

const db = new Database(":memory:");
applyMigrations(db);

const tables = (
  db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name <> 'schema_migrations'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>
).map((t) => ({ ...t, sql: t.sql.replace(/\s+/g, " ") }));

function columns(table: string): Column[] {
  return db.pragma(`table_xinfo("${table}")`) as Column[];
}

function foreignKeys(table: string): Array<{ table: string; from: string[]; onDelete: string }> {
  const rows = db.pragma(`foreign_key_list("${table}")`) as ForeignKey[];
  const byId = new Map<number, { table: string; from: string[]; onDelete: string }>();
  for (const row of rows.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
    const fk = byId.get(row.id) ?? { table: row.table, from: [], onDelete: row.on_delete };
    fk.from.push(row.from);
    byId.set(row.id, fk);
  }
  return [...byId.values()];
}

/** Every index of a table as its column list, the implicit PK/UNIQUE ones included. */
function indexes(table: string): Array<{ name: string; columns: string[]; partial: boolean }> {
  const list = db.pragma(`index_list("${table}")`) as Array<{
    name: string;
    partial: number;
    origin: string;
  }>;
  const result = list.map((ix) => ({
    name: ix.name,
    partial: ix.partial === 1,
    columns: (db.pragma(`index_info("${ix.name}")`) as Array<{ seqno: number; name: string }>)
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name),
  }));
  // A rowid table's INTEGER PRIMARY KEY is the table itself, not an index.
  const pk = columns(table)
    .filter((c) => (c as Column & { pk: number }).pk > 0)
    .sort((a, b) => (a as Column & { pk: number }).pk - (b as Column & { pk: number }).pk)
    .map((c) => c.name);
  if (pk.length && !list.some((ix) => ix.origin === "pk"))
    result.push({ name: `${table}(pk)`, columns: pk, partial: false });
  return result;
}

/** Columns that hold a 0/1 flag. A new boolean column joins this list with its CHECK. */
const BOOLEAN =
  /^(is_|must_|has_|can_)|^(email_verified|tainted|valid|stream|redacted|tombstoned|pinned|public_url|lowerable_to_l1|never_lowerable)$/;

describe("schema conventions (ADR-0031 decision 5)", () => {
  it("stores every timestamp as text", () => {
    const bad = tables.flatMap((t) =>
      columns(t.name)
        .filter((c) => c.name.endsWith("_at") && c.type !== "TEXT")
        .map((c) => `${t.name}.${c.name}`),
    );
    expect(bad).toEqual([]);
  });

  it("checks every boolean is 0 or 1", () => {
    const bad = tables.flatMap((t) =>
      columns(t.name)
        .filter((c) => BOOLEAN.test(c.name))
        .filter((c) => c.type !== "INTEGER" || !t.sql.includes(`${c.name} IN (0, 1)`))
        .map((c) => `${t.name}.${c.name}`),
    );
    expect(bad).toEqual([]);
  });

  it("validates every JSON column", () => {
    const bad = tables.flatMap((t) =>
      columns(t.name)
        .filter((c) => c.name.endsWith("_json"))
        .filter(
          (c) =>
            !t.sql.includes(`json_valid(${c.name})`) && !t.sql.includes(`json_type(${c.name})`),
        )
        .map((c) => `${t.name}.${c.name}`),
    );
    expect(bad).toEqual([]);
  });

  it("indexes every foreign key column, lookup tables aside", () => {
    const bad = tables.flatMap((t) => {
      const ix = indexes(t.name);
      return foreignKeys(t.name)
        .filter((fk) => !fk.table.endsWith("_kinds") && !fk.table.endsWith("_actions"))
        .filter(
          (fk) =>
            !ix.some(
              (i) =>
                !i.partial &&
                fk.from.every((col, n) => i.columns[n] === col) &&
                i.columns.length >= fk.from.length,
            ),
        )
        .map((fk) => `${t.name}(${fk.from.join(", ")})`);
    });
    expect(bad).toEqual([]);
  });

  it("has no index that duplicates another index or constraint", () => {
    const bad = tables.flatMap((t) => {
      const full = indexes(t.name).filter((i) => !i.partial);
      const seen = new Map<string, string>();
      const dups: string[] = [];
      for (const i of full) {
        const key = i.columns.join(",");
        const other = seen.get(key);
        if (other) dups.push(`${t.name}: ${i.name} = ${other}`);
        else seen.set(key, i.name);
      }
      return dups;
    });
    expect(bad).toEqual([]);
  });
});

describe("workspace scope (ADR-0031 decision 6)", () => {
  it("every workspace_id is NOT NULL and cascades from its workspace", () => {
    const bad = tables
      .filter((t) => t.name !== "workspaces")
      .filter((t) => columns(t.name).some((c) => c.name === "workspace_id"))
      .filter((t) => !NO_WORKSPACE_FK.has(t.name))
      .filter((t) => {
        const col = columns(t.name).find((c) => c.name === "workspace_id");
        const fk = foreignKeys(t.name).find(
          (f) => f.table === "workspaces" && f.from.length === 1 && f.from[0] === "workspace_id",
        );
        return col?.notnull !== 1 || fk?.onDelete !== "CASCADE";
      })
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it("names no default tenant in a trigger", () => {
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%tnt_default%'")
      .all();
    expect(triggers).toEqual([]);
  });
});

describe("audit record (ADR-0031 decision 11)", () => {
  it("knows exactly the actions the writer uses", () => {
    const seeded = (
      db.prepare("SELECT action FROM audit_actions ORDER BY action").all() as Array<{
        action: string;
      }>
    ).map((r) => r.action);
    expect(seeded).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("audit is append-only", () => {
    const local = new Database(":memory:");
    applyMigrations(local);
    new AuditLog(local).record({
      action: "workspace.create",
      actor: "user:usr_1",
      tenantId: "tnt_default",
      targetKind: "workspace",
      targetId: "ws_1",
    });
    expect(() => local.prepare("UPDATE audit_events SET actor = 'x'").run()).toThrow(/append-only/);
    expect(() => local.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
    expect(() =>
      local
        .prepare(
          "INSERT INTO audit_events (tenant_id, occurred_at, actor, action, target_kind, target_id) VALUES ('tnt_default', 't', 'a', 'bogus', 'k', 'i')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

/** Tables whose workspace_id deliberately outlives the workspace: the audit record (Q4). */
const NO_WORKSPACE_FK = new Set<string>(["audit_events"]);
