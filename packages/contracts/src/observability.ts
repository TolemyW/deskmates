// Run observability (ADR-0046): the append-only `obs` model a Gateway module feeds from the
// ledger, the batch it hands a sink, and the versioned contract every sink implements. Shapes and
// constants only; the Gateway reads, spools and batches, a sink writes.
//
// The model is declared once here. A sink creates exactly these tables, each with a leading
// `batch_id` column it fills from `ObservabilityBatch.batchId`, plus `ingest_batches`, and the
// views in `OBSERVABILITY_VIEWS`; dashboards read the views only. Rows travel as arrays in the
// declared column order, so a sink never guesses a column from a key.

/**
 * Bumped when a table, a column or the batch shape changes; a sink declares the one it speaks.
 * Version 2 (ADR-0046 amendment 2) added `approval_requests` and the retrospective's tables; it
 * changed no version 1 column, so a sink may upgrade a version 1 store in place.
 */
export const OBSERVABILITY_CONTRACT_VERSION = 2;

/**
 * The SQL type a sink gives a column. Timestamps are ISO-8601 UTC text, durations milliseconds.
 * `blob` is used only by the retrospective's vector table, which no batch carries.
 */
export type ObservabilityColumnType = "text" | "integer" | "real" | "blob";

export type ObservabilityColumn = readonly [name: string, type: ObservabilityColumnType];

/**
 * The tables of the model, in the order a batch carries them, each with its columns in declared
 * order (`batch_id` excluded: the sink prepends it). Snapshot tables (`*_states`, `run_marks`)
 * hold one row per observed change of a ledger row, stamped `observed_at`; fact tables hold one
 * row per ledger row. Durations are precomputed by the collector so a dashboard needs no
 * engine-specific date function.
 */
export const OBSERVABILITY_TABLE_COLUMNS = {
  /** One row per `run_events` row, with derived tool, phase, span and duration columns. */
  run_events: [
    ["event_id", "integer"],
    ["run_id", "text"],
    ["workspace_id", "text"],
    ["bot_id", "text"],
    ["attempt", "integer"],
    ["seq", "integer"],
    ["sidecar_seq", "integer"],
    ["kind", "text"],
    ["source", "text"],
    ["ts", "text"],
    ["tool_name", "text"],
    ["tool_use_id", "text"],
    ["is_error", "integer"],
    ["risk_level", "text"],
    ["model", "text"],
    ["phase", "text"],
    ["span_id", "text"],
    ["parent_span_id", "text"],
    ["edge", "text"],
    ["outcome", "text"],
    ["request_kind", "text"],
    ["duration_ms", "real"],
    ["payload_bytes", "integer"],
    ["payload_truncated", "integer"],
    ["payload_json", "text"],
  ],
  /** A run's row each time the collector sees it change. */
  run_states: [
    ["observed_at", "text"],
    ["run_id", "text"],
    ["workspace_id", "text"],
    ["bot_id", "text"],
    ["thread_id", "text"],
    ["lane", "text"],
    ["trigger_kind", "text"],
    ["run_type", "text"],
    ["status", "text"],
    ["terminal", "integer"],
    ["attempt", "integer"],
    ["model", "text"],
    ["cheap_model", "text"],
    ["error", "text"],
    ["failure_class", "text"],
    ["created_at", "text"],
    ["started_at", "text"],
    ["finished_at", "text"],
    ["queue_ms", "real"],
    ["duration_ms", "real"],
  ],
  task_states: [
    ["observed_at", "text"],
    ["task_id", "text"],
    ["workspace_id", "text"],
    ["title", "text"],
    ["owner_bot_id", "text"],
    ["status", "text"],
    ["version", "integer"],
    ["blocked_reason", "text"],
    ["created_at", "text"],
    ["updated_at", "text"],
    ["delivered_at", "text"],
    ["accepted_at", "text"],
    ["deleted_at", "text"],
    ["delivery_ms", "real"],
  ],
  /** `deleted` is 1 on the row recording that the bot left the ledger. */
  bot_states: [
    ["observed_at", "text"],
    ["bot_id", "text"],
    ["workspace_id", "text"],
    ["name", "text"],
    ["role", "text"],
    ["model", "text"],
    ["cheap_model", "text"],
    ["runtime", "text"],
    ["soul_version", "integer"],
    ["created_at", "text"],
    ["archived_at", "text"],
    ["paused_at", "text"],
    ["deleted", "integer"],
  ],
  workspace_states: [
    ["observed_at", "text"],
    ["workspace_id", "text"],
    ["tenant_id", "text"],
    ["name", "text"],
    ["status", "text"],
    ["approval_mode", "text"],
    ["created_at", "text"],
    ["archived_at", "text"],
    ["deleted", "integer"],
  ],
  /** `title` is null for a private chat (`private` = 1): it is its person's alone (ADR-0022). */
  thread_states: [
    ["observed_at", "text"],
    ["thread_id", "text"],
    ["workspace_id", "text"],
    ["kind", "text"],
    ["channel", "text"],
    ["title", "text"],
    ["private", "integer"],
    ["status", "text"],
    ["owner_bot_id", "text"],
    ["turn_budget", "integer"],
    ["created_at", "text"],
    ["updated_at", "text"],
  ],
  model_requests: [
    ["request_id", "integer"],
    ["run_id", "text"],
    ["workspace_id", "text"],
    ["bot_id", "text"],
    ["attempt", "integer"],
    ["seq", "integer"],
    ["ts", "text"],
    ["request_kind", "text"],
    ["model", "text"],
    ["served_model", "text"],
    ["rewritten_from", "text"],
    ["refusal", "text"],
    ["stream", "integer"],
    ["input_tokens", "integer"],
    ["output_tokens", "integer"],
    ["cache_read_tokens", "integer"],
    ["cache_create_tokens", "integer"],
    ["thinking_tokens", "integer"],
    ["prompt_tokens", "integer"],
    ["image_blocks", "integer"],
    ["cache_control_blocks", "integer"],
    ["system_blocks", "integer"],
    ["system_chars", "integer"],
    ["tools_count", "integer"],
    ["tools_chars", "integer"],
    ["messages_count", "integer"],
    ["system_sha256", "text"],
    ["system_static_sha256", "text"],
    ["system_dynamic_sha256", "text"],
  ],
  run_usage: [
    ["usage_id", "integer"],
    ["run_id", "text"],
    ["workspace_id", "text"],
    ["bot_id", "text"],
    ["attempt", "integer"],
    ["model", "text"],
    ["input_tokens", "integer"],
    ["output_tokens", "integer"],
    ["cache_read_tokens", "integer"],
    ["cache_create_tokens", "integer"],
    ["cost_usd", "real"],
  ],
  task_runs: [
    ["task_id", "text"],
    ["ordinal", "integer"],
    ["run_id", "text"],
    ["workspace_id", "text"],
  ],
  /** ADR-0042 marks; `verdict` is `unmarked` on the row recording that a mark was removed. */
  run_marks: [
    ["observed_at", "text"],
    ["run_id", "text"],
    ["workspace_id", "text"],
    ["verdict", "text"],
    ["note", "text"],
    ["marked_by", "text"],
    ["marked_at", "text"],
  ],
  /** ADR-0033 Activity summaries, one row per change; no vector until decision 9. */
  run_summaries: [
    ["run_id", "text"],
    ["source_version", "text"],
    ["workspace_id", "text"],
    ["status", "text"],
    ["text", "text"],
    ["created_at", "text"],
    ["updated_at", "text"],
  ],
  /** One row per decided approval; `wait_ms` is how long the thread waited for the answer. */
  approval_decisions: [
    ["approval_id", "text"],
    ["run_id", "text"],
    ["workspace_id", "text"],
    ["bot_id", "text"],
    ["thread_id", "text"],
    ["kind", "text"],
    ["risk_level", "text"],
    ["tool_name", "text"],
    ["wait_mode", "text"],
    ["decision", "text"],
    ["decided_by", "text"],
    ["decider_kind", "text"],
    ["rule_id", "text"],
    ["created_at", "text"],
    ["decided_at", "text"],
    ["wait_ms", "real"],
  ],
  /**
   * One row per approval when it is created, decided or not (ADR-0046 amendment 2 decision 22): a
   * request without an `approval_decisions` row is pending.
   */
  approval_requests: [
    ["approval_id", "text"],
    ["run_id", "text"],
    ["workspace_id", "text"],
    ["bot_id", "text"],
    ["thread_id", "text"],
    ["kind", "text"],
    ["risk_level", "text"],
    ["tool_name", "text"],
    ["wait_mode", "text"],
    ["created_at", "text"],
  ],
} as const satisfies Record<string, readonly ObservabilityColumn[]>;

export type ObservabilityTable = keyof typeof OBSERVABILITY_TABLE_COLUMNS;

export const OBSERVABILITY_TABLES = Object.keys(
  OBSERVABILITY_TABLE_COLUMNS,
) as readonly ObservabilityTable[];

/**
 * The commit record: one row per committed table of a batch, under the unique `token`. It is the
 * data watermark (the `watermarks` view) and what makes a replayed table a no-op.
 */
export const OBSERVABILITY_INGEST_COLUMNS = [
  ["token", "text"],
  ["batch_id", "text"],
  ["table_name", "text"],
  ["row_count", "integer"],
  ["source_first", "text"],
  ["source_last", "text"],
  ["opened_at", "text"],
  ["closed_at", "text"],
  ["committed_at", "text"],
] as const satisfies readonly ObservabilityColumn[];

/**
 * The retrospective's tables (ADR-0046 decision 9, amendment 2 decisions 23 to 25), kept only by a
 * sink that declares `capabilities.vectors`. They are written through
 * `ObservabilitySinkRuntime.vectors`, never by a batch, so they have no `batch_id`. `vector` is
 * the L2-normalised embedding as little-endian float32 (ADR-0041 decision 3's format).
 */
export const OBSERVABILITY_VECTOR_TABLE_COLUMNS = {
  /** One row per run and embedding model: the run's Activity summary as a vector. */
  run_vectors: [
    ["run_id", "text"],
    ["source_version", "text"],
    ["workspace_id", "text"],
    ["outcome", "text"],
    ["failure_class", "text"],
    ["embedding_model", "text"],
    ["dims", "integer"],
    ["vector", "blob"],
    ["finished_at", "text"],
    ["embedded_at", "text"],
  ],
  /** A failed run's nearest succeeded runs of its workspace, rank 1 the most similar. */
  retrospective_matches: [
    ["failed_run_id", "text"],
    ["source_version", "text"],
    ["workspace_id", "text"],
    ["embedding_model", "text"],
    ["rank", "integer"],
    ["match_run_id", "text"],
    ["similarity", "real"],
    ["computed_at", "text"],
  ],
  /** The retrospective's position in the ledger, beside the vectors it describes. */
  retrospective_state: [
    ["key", "text"],
    ["value", "text"],
  ],
} as const satisfies Record<string, readonly ObservabilityColumn[]>;

export type ObservabilityVectorTable = keyof typeof OBSERVABILITY_VECTOR_TABLE_COLUMNS;

/** The only relations a dashboard query may name (ADR-0046 decisions 1 and 7, amendment 2). */
export const OBSERVABILITY_VIEWS = [
  "runs_latest",
  "runs_named",
  "tool_calls",
  "phase_spans",
  "model_request_timing",
  "model_latency",
  "requests_named",
  "request_cache",
  "run_metrics",
  "approval_waits",
  "approval_requests_named",
  "failure_matches",
  "watermarks",
] as const;

export type ObservabilityView = (typeof OBSERVABILITY_VIEWS)[number];

/** A row value; JSON travels as text in `payload_json`. */
export type ObservabilityValue = string | number | null;

export type ObservabilityRow = readonly ObservabilityValue[];

/** `full` keeps payload bodies (truncated past the cap); `derived` sends none (decision 2). */
export type ObservabilityPayloadPolicy = "full" | "derived";

export const OBSERVABILITY_PAYLOAD_POLICIES = [
  "full",
  "derived",
] as const satisfies readonly ObservabilityPayloadPolicy[];

/** A payload body larger than this, in UTF-8 bytes, is truncated with its size recorded. */
export const OBSERVABILITY_PAYLOAD_MAX_BYTES = 65536;

/** Where a table's rows of one batch came from, as the collector's cursor before and after. */
export interface ObservabilitySourceRange {
  /** The cursor before the batch's first row; null when the collector started from nothing. */
  first: string | null;
  last: string;
}

/** One closed batch, handed to a sink whole; replaying it after a crash is always safe. */
export interface ObservabilityBatch {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  /** Sortable: a later batch has a greater id. */
  batchId: string;
  openedAt: string;
  closedAt: string;
  /** Only tables with rows are present; each row is in `OBSERVABILITY_TABLE_COLUMNS` order. */
  tables: Partial<Record<ObservabilityTable, readonly ObservabilityRow[]>>;
  sources: Partial<Record<ObservabilityTable, ObservabilitySourceRange>>;
}

/** The token a sink commits one table of one batch under (decision 3). */
export function observabilityCommitToken(table: ObservabilityTable, batchId: string): string {
  return `obs/${table}/${batchId}`;
}

export type ObservabilityDialect = "sqlite" | "postgres" | "none";

export interface ObservabilitySinkManifest {
  /** The `OBSERVABILITY_SINK` value that selects it. */
  id: string;
  version: string;
  contractVersion: number;
  /** What it writes to, e.g. `sqlite`; shown on the status route. */
  engine: string;
  capabilities: {
    /** Whether it stores vectors for the retrospective (decision 9). */
    vectors: boolean;
    /** The SQL its views are written in; `none` for a sink that only forwards. */
    dialect: ObservabilityDialect;
  };
}

export interface ObservabilityWriteResult {
  /** Every token of the batch now committed, including ones committed by an earlier attempt. */
  committed: string[];
}

/** What a sink may report about itself for the status route; every field optional. */
export interface ObservabilitySinkStats {
  /** Size of the store, where the sink can tell (the SQLite file). */
  bytes?: number;
  /** Rows its own retention removed in its last pass, and when. */
  lastPrune?: { at: string; rows: number };
}

/** A run's Activity summary as a vector, for the retrospective (amendment 2 decision 23). */
export interface ObservabilityRunVector {
  runId: string;
  /** ADR-0033's source version of the run when its summary was embedded. */
  sourceVersion: string;
  workspaceId: string;
  outcome: "succeeded" | "failed";
  failureClass: string | null;
  /** `EMBEDDING_MODEL`; vectors of different models are never compared. */
  embeddingModel: string;
  /** L2-normalised, so cosine similarity is a dot product. */
  vector: Float32Array;
  finishedAt: string;
  embeddedAt: string;
}

/** One stored match of a failed run (amendment 2 decision 25). */
export interface ObservabilityRetrospectiveMatch {
  matchRunId: string;
  /** 1 is the most similar. */
  rank: number;
  similarity: number;
}

/** Where the retrospective has read the ledger to: finished runs as an `(at, id)` keyset. */
export interface ObservabilityRetrospectiveCursor {
  at: string;
  id: string;
}

/**
 * The vector store of a sink that declares `capabilities.vectors`. It stores and returns vectors;
 * the Gateway module computes similarity (amendment 2 decision 23). Nothing but the module's
 * retrospective reads it (decision 10).
 */
export interface ObservabilityVectorStore {
  /** Per run id, the source version stored under `embeddingModel`; runs without one are absent. */
  embeddedVersions(embeddingModel: string, runIds: readonly string[]): Promise<Map<string, string>>;
  /** Insert or replace each run's vector under its embedding model. */
  putVectors(rows: readonly ObservabilityRunVector[]): Promise<void>;
  /** The succeeded runs' vectors of one workspace under `embeddingModel`. */
  succeeded(
    workspaceId: string,
    embeddingModel: string,
  ): Promise<Array<{ runId: string; vector: Float32Array }>>;
  /** Replace the failed run's matches under its embedding model. */
  putMatches(
    failed: {
      runId: string;
      sourceVersion: string;
      workspaceId: string;
      embeddingModel: string;
      computedAt: string;
    },
    matches: readonly ObservabilityRetrospectiveMatch[],
  ): Promise<void>;
  cursor(): Promise<ObservabilityRetrospectiveCursor | null>;
  setCursor(cursor: ObservabilityRetrospectiveCursor): Promise<void>;
}

/** The versioned runtime a release-bundled sink entry point returns (decision 3). */
export interface ObservabilitySinkRuntime {
  readonly manifest: ObservabilitySinkManifest;
  /** Present exactly when `manifest.capabilities.vectors` is true. */
  readonly vectors?: ObservabilityVectorStore;
  /** Create the tables and views if missing; idempotent; refuses another contract version. */
  ensureSchema(): Promise<void>;
  /** Commit each table of the batch under its token; a committed token is skipped. */
  writeBatch(batch: ObservabilityBatch): Promise<ObservabilityWriteResult>;
  /** The greatest batch id with a committed table, or null for an empty sink. */
  lastCommitted(): Promise<string | null>;
  stats?(): Promise<ObservabilitySinkStats>;
  close(): Promise<void>;
}

/** Per table: the collector's cursor for what it has spooled and for what the sink committed. */
export interface ObservabilityTableStatus {
  table: ObservabilityTable;
  received: string | null;
  committed: string | null;
}

/** `GET /api/observability/status` (root only, decision 8). */
export interface ObservabilityStatus {
  enabled: boolean;
  /** `OBSERVABILITY_GRAFANA_URL`, or null: the Grafana the analytics relay forwards to. */
  grafanaUrl: string | null;
  sink: Pick<ObservabilitySinkManifest, "id" | "version" | "engine" | "contractVersion"> | null;
  payloads: ObservabilityPayloadPolicy | null;
  batchSeconds: number | null;
  batchBytes: number | null;
  /** Null is unlimited. */
  retentionDays: number | null;
  tables: ObservabilityTableStatus[];
  /** The newest closed batch, committed or waiting for the sink. */
  newestBatch: {
    batchId: string;
    closedAt: string;
    ageSeconds: number;
    committed: boolean;
  } | null;
  /** The batch being filled, if any rows arrived since the last close. */
  openBatch: { batchId: string; openedAt: string; bytes: number } | null;
  /** Closed batches the sink has not committed yet. */
  pendingBatches: number;
  /** Bytes in the spool directory: the open batch plus pending ones. */
  spoolBytes: number;
  sinkStats: ObservabilitySinkStats | null;
  lastError: { at: string; message: string } | null;
  /** The failure retrospective (amendment 2 decision 26); null when it does not run. */
  retrospective?: ObservabilityRetrospectiveStatus | null;
}

export interface ObservabilityRetrospectiveStatus {
  embeddingModel: string;
  /** The finished run the walk has passed, as `<finished_at> <run id>`, or null at the start. */
  position: string | null;
  /** Runs embedded and failed runs matched since the Gateway started. */
  embedded: number;
  matched: number;
  lastError: { at: string; message: string } | null;
}
