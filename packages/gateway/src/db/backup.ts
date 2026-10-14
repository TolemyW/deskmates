// Coherent backup and safe restore of the Gateway database (ADR-0022 decision 5, MIG-04).
//
// A backup uses SQLite's online backup API, so it is one consistent snapshot that includes what
// is still only in the WAL, taken while the Gateway keeps running. A manifest beside it records
// the schema level, row counts and the file's SHA-256. A restore refuses a file whose hash does
// not match, keeps the database it replaces, and then invalidates every credential the backup
// carried: sessions, tenant grants, run tokens, sign-in and OAuth transactions and open
// invitations. A restored database therefore never signs anyone in or resumes any authority;
// people sign in again. Docker volumes and the integration runtime's state are outside this
// file and are covered by the runbook.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DeskmatesError } from "@deskmates/contracts";
import Database from "better-sqlite3";
import { assertNamesNotPreBaseline, listMigrationFiles } from "./migrate.js";
import { openDatabase } from "./open.js";

export interface BackupManifest {
  kind: "deskmates-gateway-backup";
  createdAt: string;
  sha256: string;
  migrations: string[];
  tables: Record<string, number>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tableCounts(db: Database.Database): Record<string, number> {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  return Object.fromEntries(
    tables.map((name) => [
      name,
      (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ]),
  );
}

export function manifestPath(backupPath: string): string {
  return `${backupPath}.manifest.json`;
}

/** Write a consistent copy of `sourcePath` to `outPath` and its manifest beside it. */
export async function backupDatabase(sourcePath: string, outPath: string): Promise<BackupManifest> {
  if (existsSync(outPath) || existsSync(manifestPath(outPath)))
    throw new DeskmatesError("invalid_transition", `${outPath} already exists; choose a new file`);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(outPath);
  } finally {
    source.close();
  }
  const copy = new Database(outPath, { readonly: true });
  let manifest: BackupManifest;
  try {
    const integrity = copy.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new DeskmatesError("validation", `backup integrity: ${integrity}`);
    manifest = {
      kind: "deskmates-gateway-backup",
      createdAt: new Date().toISOString(),
      sha256: "",
      migrations: (
        copy.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
      tables: tableCounts(copy),
    };
  } finally {
    copy.close();
  }
  manifest.sha256 = sha256(outPath);
  writeFileSync(manifestPath(outPath), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export interface RestoreResult {
  /** Where the replaced database was kept, when there was one. */
  previous: string | null;
  sessionsRevoked: number;
  runTokensRevoked: number;
  invitationsRevoked: number;
  serviceTokensRevoked: number;
}

/**
 * Restore `backupPath` as the database at `targetPath`. The Gateway must be stopped. Verifies
 * the manifest hash, moves any existing database (and its WAL files) aside, then opens the
 * restored copy, migrates it forward and invalidates every credential it carried.
 */
export function restoreDatabase(
  backupPath: string,
  targetPath: string,
  now: Date = new Date(),
): RestoreResult {
  const manifestFile = manifestPath(backupPath);
  if (!existsSync(backupPath) || !existsSync(manifestFile))
    throw new DeskmatesError("not_found", "backup or its manifest is missing");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as BackupManifest;
  if (manifest.kind !== "deskmates-gateway-backup" || manifest.sha256 !== sha256(backupPath))
    throw new DeskmatesError(
      "validation",
      "backup does not match its manifest; refusing to restore",
    );
  // Refuse a backup this binary would refuse to open before the current database is moved aside
  // (ADR-0031 decision 3): a pre-baseline one, or one written by a newer Gateway.
  try {
    assertNamesNotPreBaseline(manifest.migrations);
  } catch (err) {
    throw new DeskmatesError("invalid_transition", (err as Error).message);
  }
  const known = new Set(listMigrationFiles());
  const unknown = manifest.migrations.filter((name) => !known.has(name));
  if (unknown.length > 0)
    throw new DeskmatesError(
      "invalid_transition",
      `backup was written by a newer Gateway (${unknown.join(", ")}); restore it with that release`,
    );
  let previous: string | null = null;
  if (existsSync(targetPath)) {
    previous = `${targetPath}.pre-restore-${now.toISOString().replace(/[:.]/g, "-")}`;
    renameSync(targetPath, previous);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(`${targetPath}${suffix}`))
        renameSync(`${targetPath}${suffix}`, `${previous}${suffix}`);
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${targetPath}${suffix}`, { force: true });
  copyFileSync(backupPath, targetPath);
  const db = openDatabase(targetPath);
  try {
    const at = now.toISOString();
    return db
      .transaction(() => {
        const sessionsRevoked = db
          .prepare(
            "UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'maintenance' WHERE revoked_at IS NULL",
          )
          .run(at).changes;
        db.prepare("UPDATE tenant_auth_grants SET revoked_at = ? WHERE revoked_at IS NULL").run(at);
        const runTokensRevoked = db
          .prepare("UPDATE run_tokens SET revoked_at = ? WHERE revoked_at IS NULL")
          .run(at).changes;
        db.prepare("DELETE FROM oidc_login_transactions").run();
        db.prepare("UPDATE integration_oauth_states SET used_at = ? WHERE used_at IS NULL").run(at);
        const invitationsRevoked = db
          .prepare(
            "UPDATE invitations SET revoked_at = ? WHERE revoked_at IS NULL AND consumed_at IS NULL",
          )
          .run(at).changes;
        // A service principal's token is a credential too (ADR-0022 amendment 2): clear it, so
        // a principal disabled or rotated after the backup cannot come back. An Admin rotates.
        const serviceTokensRevoked = db
          .prepare(
            "UPDATE service_principals SET token_hash = NULL, token_issued_at = NULL WHERE token_hash IS NOT NULL",
          )
          .run().changes;
        return {
          previous,
          sessionsRevoked,
          runTokensRevoked,
          invitationsRevoked,
          serviceTokensRevoked,
        };
      })
      .immediate();
  } finally {
    db.close();
  }
}
