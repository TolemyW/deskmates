// The built-in observability sink (ADR-0046 decision 4): `obs.sqlite`, a second SQLite file
// beside the ledger, in WAL mode with `synchronous = FULL` so a table the collector was told is
// committed survives a power cut. One transaction per table per batch; the table's commit token
// goes into `ingest_batches` in the same transaction, under a unique index, so a replayed table
// is skipped. Retention (`OBSERVABILITY_RETENTION_DAYS`) is this file's own, independent of the
// ledger's, and runs at most hourly after a commit.
//
// It declares `capabilities.vectors` (ADR-0046 amendment 2 decision 23): the retrospective's
// vectors are stored as L2-normalised little-endian float32 BLOBs in `run_vectors`, the format of
// ADR-0041 decision 3, with no SQLite extension; the Gateway module computes the similarity.

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_TABLES,
  OBSERVABILITY_TABLE_COLUMNS,
  type ObservabilityBatch,
  type ObservabilitySinkManifest,
  type ObservabilitySinkRuntime,
  type ObservabilitySinkStats,
  type ObservabilityTable,
  type ObservabilityVectorStore,
  observabilityCommitToken,
} from "@deskmates/contracts";
import Database from "better-sqlite3";
import { fromBlob, toBlob } from "../retrieval/vectors.js";

/** `packages/gateway/observability/sqlite.sql`, from `src/observability/` and `dist/observability/`. */
export const SQLITE_SCHEMA_PATH = fileURLToPath(
  new URL("../../observability/sqlite.sql", import.meta.url),
);

export const SQLITE_SINK_MANIFEST: ObservabilitySinkManifest = {
  id: "sqlite",
  version: "2",
  contractVersion: OBSERVABILITY_CONTRACT_VERSION,
  engine: "sqlite",
  capabilities: { vectors: true, dialect: "sqlite" },
};

/**
 * Contract versions a file may hold that this release upgrades in place by running the schema
 * again: version 2 only added tables (amendment 2 decision 22).
 */
const UPGRADABLE_VERSIONS: ReadonlySet<number> = new Set([1]);

const CURSOR_KEY = "cursor";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Snapshot tables and their key: retention keeps the newest row of every key. */
const SNAPSHOT_KEYS: Partial<Record<ObservabilityTable, string>> = {
  bot_states: "bot_id",
  workspace_states: "workspace_id",
  thread_states: "thread_id",
  task_states: "task_id",
  run_marks: "run_id",
};

export interface SqliteSinkOptions {
  path: string;
  retentionDays?: number;
  now?: () => Date;
  /** T1 only: called before each table's transaction, so a test can stop a batch midway. */
  beforeTable?: (table: ObservabilityTable) => void;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createSqliteSink(options: SqliteSinkOptions): ObservabilitySinkRuntime {
  if (options.path === ":memory:") throw new Error("the sqlite observability sink needs a file");
  const now = options.now ?? (() => new Date());
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  let lastPruneAt = 0;
  let lastPrune: ObservabilitySinkStats["lastPrune"];

  const inserts = new Map<ObservabilityTable, Database.Statement>();
  const insertFor = (table: ObservabilityTable): Database.Statement => {
    let stmt = inserts.get(table);
    if (!stmt) {
      const columns = OBSERVABILITY_TABLE_COLUMNS[table].map(([name]) => name);
      stmt = db.prepare(
        `INSERT INTO ${table} (batch_id, ${columns.join(", ")}) VALUES (?${", ?".repeat(columns.length)})`,
      );
      inserts.set(table, stmt);
    }
    return stmt;
  };

  const prune = (): void => {
    const days = options.retentionDays;
    if (days === undefined) return;
    const at = now();
    if (at.getTime() - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = at.getTime();
    const cutoff = new Date(at.getTime() - days * DAY_MS).toISOString();
    const last = (
      db
        .prepare("SELECT max(batch_id) AS b FROM ingest_batches WHERE closed_at < ?")
        .get(cutoff) as { b: string | null }
    ).b;
    let rows = 0;
    if (last !== null) {
      db.transaction(() => {
        for (const table of OBSERVABILITY_TABLES) {
          const key = SNAPSHOT_KEYS[table];
          if (table === "run_states") {
            // A run whose newest snapshot aged out and is terminal goes entirely; otherwise only
            // its superseded snapshots go.
            rows += db
              .prepare(
                `DELETE FROM run_states WHERE batch_id <= @last AND rowid NOT IN (
                   SELECT rowid FROM (
                     SELECT rowid, terminal, batch_id AS b, ROW_NUMBER() OVER (
                       PARTITION BY run_id ORDER BY batch_id DESC, observed_at DESC) AS rn
                       FROM run_states)
                    WHERE rn = 1 AND NOT (terminal = 1 AND b <= @last))`,
              )
              .run({ last }).changes;
          } else if (key) {
            rows += db
              .prepare(
                `DELETE FROM ${table} WHERE batch_id <= @last AND rowid NOT IN (
                   SELECT rowid FROM (
                     SELECT rowid, ROW_NUMBER() OVER (
                       PARTITION BY ${key} ORDER BY batch_id DESC, observed_at DESC) AS rn
                       FROM ${table})
                    WHERE rn = 1)`,
              )
              .run({ last }).changes;
          } else {
            rows += db.prepare(`DELETE FROM ${table} WHERE batch_id <= ?`).run(last).changes;
          }
        }
        // The newest batch's tokens stay: `lastCommitted` and a replay of it still need them.
        db.prepare(
          `DELETE FROM ingest_batches
            WHERE batch_id <= ? AND batch_id < (SELECT max(batch_id) FROM ingest_batches)`,
        ).run(last);
        // The retrospective follows its runs: a run with no snapshot left loses its vector and
        // every match it is on. Only rows older than the cutoff go, so a vector written before its
        // run's first snapshot reached this file is not taken for a pruned run.
        rows += db
          .prepare(
            `DELETE FROM retrospective_matches WHERE computed_at < @cutoff AND (
               failed_run_id NOT IN (SELECT run_id FROM run_states WHERE run_id IS NOT NULL)
               OR match_run_id NOT IN (SELECT run_id FROM run_states WHERE run_id IS NOT NULL))`,
          )
          .run({ cutoff }).changes;
        rows += db
          .prepare(
            `DELETE FROM run_vectors WHERE embedded_at < @cutoff
                AND run_id NOT IN (SELECT run_id FROM run_states WHERE run_id IS NOT NULL)`,
          )
          .run({ cutoff }).changes;
      })();
    }
    lastPrune = { at: at.toISOString(), rows };
  };

  const vectors: ObservabilityVectorStore = {
    async embeddedVersions(embeddingModel, runIds) {
      const out = new Map<string, string>();
      if (runIds.length === 0) return out;
      const rows = db
        .prepare(
          `SELECT run_id, source_version FROM run_vectors
            WHERE embedding_model = ? AND run_id IN (SELECT value FROM json_each(?))`,
        )
        .all(embeddingModel, JSON.stringify(runIds)) as Array<{
        run_id: string;
        source_version: string;
      }>;
      for (const row of rows) out.set(row.run_id, row.source_version);
      return out;
    },

    async putVectors(rows) {
      const put = db.prepare(
        `INSERT INTO run_vectors (run_id, source_version, workspace_id, outcome, failure_class,
           embedding_model, dims, vector, finished_at, embedded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, embedding_model) DO UPDATE SET
           source_version = excluded.source_version, workspace_id = excluded.workspace_id,
           outcome = excluded.outcome, failure_class = excluded.failure_class,
           dims = excluded.dims, vector = excluded.vector, finished_at = excluded.finished_at,
           embedded_at = excluded.embedded_at`,
      );
      db.transaction(() => {
        for (const row of rows)
          put.run(
            row.runId,
            row.sourceVersion,
            row.workspaceId,
            row.outcome,
            row.failureClass,
            row.embeddingModel,
            row.vector.length,
            toBlob(row.vector),
            row.finishedAt,
            row.embeddedAt,
          );
      }).immediate();
    },

    async succeeded(workspaceId, embeddingModel) {
      const rows = db
        .prepare(
          `SELECT run_id, vector FROM run_vectors
            WHERE workspace_id = ? AND embedding_model = ? AND outcome = 'succeeded'
            ORDER BY run_id`,
        )
        .all(workspaceId, embeddingModel) as Array<{ run_id: string; vector: Buffer }>;
      return rows.map((row) => ({ runId: row.run_id, vector: fromBlob(row.vector) }));
    },

    async putMatches(failed, matches) {
      const clear = db.prepare(
        "DELETE FROM retrospective_matches WHERE failed_run_id = ? AND embedding_model = ?",
      );
      const put = db.prepare(
        `INSERT INTO retrospective_matches (failed_run_id, source_version, workspace_id,
           embedding_model, rank, match_run_id, similarity, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        clear.run(failed.runId, failed.embeddingModel);
        for (const match of matches)
          put.run(
            failed.runId,
            failed.sourceVersion,
            failed.workspaceId,
            failed.embeddingModel,
            match.rank,
            match.matchRunId,
            match.similarity,
            failed.computedAt,
          );
      }).immediate();
    },

    async cursor() {
      const row = db
        .prepare("SELECT value FROM retrospective_state WHERE key = ?")
        .get(CURSOR_KEY) as { value: string | null } | undefined;
      if (!row?.value) return null;
      const parsed = JSON.parse(row.value) as { at?: unknown; id?: unknown };
      return typeof parsed.at === "string" && typeof parsed.id === "string"
        ? { at: parsed.at, id: parsed.id }
        : null;
    },

    async setCursor(cursor) {
      db.prepare(
        `INSERT INTO retrospective_state (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(CURSOR_KEY, JSON.stringify({ at: cursor.at, id: cursor.id }));
    },
  };

  return {
    manifest: SQLITE_SINK_MANIFEST,
    vectors,

    async ensureSchema() {
      const version = db.pragma("user_version", { simple: true }) as number;
      const hasTables =
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .get() as { n: number }
        ).n > 0;
      if (
        hasTables &&
        version !== OBSERVABILITY_CONTRACT_VERSION &&
        !UPGRADABLE_VERSIONS.has(version)
      )
        throw new Error(
          `${options.path} holds observability contract version ${version}; this release writes version ${OBSERVABILITY_CONTRACT_VERSION}`,
        );
      db.exec(readFileSync(SQLITE_SCHEMA_PATH, "utf8"));
      db.pragma(`user_version = ${OBSERVABILITY_CONTRACT_VERSION}`);
    },

    async writeBatch(batch: ObservabilityBatch) {
      const committed: string[] = [];
      const known = db.prepare("SELECT 1 FROM ingest_batches WHERE token = ?");
      const record = db.prepare(
        `INSERT INTO ingest_batches
           (token, batch_id, table_name, row_count, source_first, source_last, opened_at, closed_at,
            committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const table of OBSERVABILITY_TABLES) {
        const rows = batch.tables[table];
        if (!rows || rows.length === 0) continue;
        const token = observabilityCommitToken(table, batch.batchId);
        options.beforeTable?.(table);
        const width = OBSERVABILITY_TABLE_COLUMNS[table].length;
        db.transaction(() => {
          if (known.get(token)) return;
          const insert = insertFor(table);
          for (const row of rows) {
            if (row.length !== width)
              throw new Error(`${table} row has ${row.length} values, expected ${width}`);
            insert.run(batch.batchId, ...row);
          }
          const source = batch.sources[table];
          record.run(
            token,
            batch.batchId,
            table,
            rows.length,
            source?.first ?? null,
            source?.last ?? null,
            batch.openedAt,
            batch.closedAt,
            now().toISOString(),
          );
        }).immediate();
        committed.push(token);
        // A large batch must not hold the Gateway's event loop for every table at once.
        await yieldToEventLoop();
      }
      prune();
      return { committed };
    },

    async lastCommitted() {
      return (
        db.prepare("SELECT max(batch_id) AS b FROM ingest_batches").get() as { b: string | null }
      ).b;
    },

    async stats() {
      let bytes = 0;
      for (const suffix of ["", "-wal"]) {
        try {
          bytes += statSync(`${options.path}${suffix}`).size;
        } catch {
          // The WAL file comes and goes with checkpoints.
        }
      }
      return { bytes, ...(lastPrune ? { lastPrune } : {}) };
    },

    async close() {
      db.close();
    },
  };
}
