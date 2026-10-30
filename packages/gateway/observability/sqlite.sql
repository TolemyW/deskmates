-- The `obs` model in SQLite SQL (ADR-0046 decisions 1 and 4). This file is applied by the
-- `sqlite` observability sink to `obs.sqlite`, a second file beside the ledger; it is not a ledger
-- migration and the Gateway database never sees it. The columns of each table are
-- `OBSERVABILITY_TABLE_COLUMNS` in `@deskmates/contracts`, after a leading `batch_id`;
-- `model.test.ts` fails when the two disagree. Tables are created if missing; the views are
-- dropped and recreated on every start, so a view change needs no migration. PRAGMA user_version
-- holds the contract version and a file of another version is refused.
--
-- Dashboards read the views only. Snapshot tables hold one row per observed change; the views
-- pick the latest row per key with ROW_NUMBER() over (batch_id, observed_at).
--
-- Contract version 2 (ADR-0046 amendment 2) added `approval_requests` and the retrospective's
-- tables (`run_vectors`, `retrospective_matches`, `retrospective_state`) and changed no version 1
-- column, so the sink upgrades a version 1 file by running this file again.

CREATE TABLE IF NOT EXISTS run_events (
  batch_id           TEXT NOT NULL,
  event_id           INTEGER,
  run_id             TEXT,
  workspace_id       TEXT,
  bot_id             TEXT,
  attempt            INTEGER,
  seq                INTEGER,
  sidecar_seq        INTEGER,
  kind               TEXT,
  source             TEXT,
  ts                 TEXT,
  tool_name          TEXT,
  tool_use_id        TEXT,
  is_error           INTEGER,
  risk_level         TEXT,
  model              TEXT,
  phase              TEXT,
  span_id            TEXT,
  parent_span_id     TEXT,
  edge               TEXT,
  outcome            TEXT,
  request_kind       TEXT,
  duration_ms        REAL,
  payload_bytes      INTEGER,
  payload_truncated  INTEGER,
  payload_json       TEXT
);
CREATE INDEX IF NOT EXISTS run_events_batch ON run_events(batch_id);
CREATE INDEX IF NOT EXISTS run_events_run_kind ON run_events(run_id, kind);
CREATE INDEX IF NOT EXISTS run_events_tool_use ON run_events(run_id, tool_use_id);
CREATE INDEX IF NOT EXISTS run_events_kind_ts ON run_events(kind, ts);
CREATE INDEX IF NOT EXISTS run_events_source_ts ON run_events(source, ts);

CREATE TABLE IF NOT EXISTS run_states (
  batch_id       TEXT NOT NULL,
  observed_at    TEXT,
  run_id         TEXT,
  workspace_id   TEXT,
  bot_id         TEXT,
  thread_id      TEXT,
  lane           TEXT,
  trigger_kind   TEXT,
  run_type       TEXT,
  status         TEXT,
  terminal       INTEGER,
  attempt        INTEGER,
  model          TEXT,
  cheap_model    TEXT,
  error          TEXT,
  failure_class  TEXT,
  created_at     TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  queue_ms       REAL,
  duration_ms    REAL
);
CREATE INDEX IF NOT EXISTS run_states_batch ON run_states(batch_id);
CREATE INDEX IF NOT EXISTS run_states_run ON run_states(run_id, batch_id, observed_at);

CREATE TABLE IF NOT EXISTS task_states (
  batch_id        TEXT NOT NULL,
  observed_at     TEXT,
  task_id         TEXT,
  workspace_id    TEXT,
  title           TEXT,
  owner_bot_id    TEXT,
  status          TEXT,
  version         INTEGER,
  blocked_reason  TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  delivered_at    TEXT,
  accepted_at     TEXT,
  deleted_at      TEXT,
  delivery_ms     REAL
);
CREATE INDEX IF NOT EXISTS task_states_batch ON task_states(batch_id);
CREATE INDEX IF NOT EXISTS task_states_task ON task_states(task_id, batch_id, observed_at);

CREATE TABLE IF NOT EXISTS bot_states (
  batch_id      TEXT NOT NULL,
  observed_at   TEXT,
  bot_id        TEXT,
  workspace_id  TEXT,
  name          TEXT,
  role          TEXT,
  model         TEXT,
  cheap_model   TEXT,
  runtime       TEXT,
  soul_version  INTEGER,
  created_at    TEXT,
  archived_at   TEXT,
  paused_at     TEXT,
  deleted       INTEGER
);
CREATE INDEX IF NOT EXISTS bot_states_batch ON bot_states(batch_id);
CREATE INDEX IF NOT EXISTS bot_states_bot ON bot_states(bot_id, batch_id, observed_at);

CREATE TABLE IF NOT EXISTS workspace_states (
  batch_id       TEXT NOT NULL,
  observed_at    TEXT,
  workspace_id   TEXT,
  tenant_id      TEXT,
  name           TEXT,
  status         TEXT,
  approval_mode  TEXT,
  created_at     TEXT,
  archived_at    TEXT,
  deleted        INTEGER
);
CREATE INDEX IF NOT EXISTS workspace_states_batch ON workspace_states(batch_id);
CREATE INDEX IF NOT EXISTS workspace_states_workspace
  ON workspace_states(workspace_id, batch_id, observed_at);

CREATE TABLE IF NOT EXISTS thread_states (
  batch_id      TEXT NOT NULL,
  observed_at   TEXT,
  thread_id     TEXT,
  workspace_id  TEXT,
  kind          TEXT,
  channel       TEXT,
  title         TEXT,
  private       INTEGER,
  status        TEXT,
  owner_bot_id  TEXT,
  turn_budget   INTEGER,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS thread_states_batch ON thread_states(batch_id);
CREATE INDEX IF NOT EXISTS thread_states_thread ON thread_states(thread_id, batch_id, observed_at);

CREATE TABLE IF NOT EXISTS model_requests (
  batch_id               TEXT NOT NULL,
  request_id             INTEGER,
  run_id                 TEXT,
  workspace_id           TEXT,
  bot_id                 TEXT,
  attempt                INTEGER,
  seq                    INTEGER,
  ts                     TEXT,
  request_kind           TEXT,
  model                  TEXT,
  served_model           TEXT,
  rewritten_from         TEXT,
  refusal                TEXT,
  stream                 INTEGER,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  cache_read_tokens      INTEGER,
  cache_create_tokens    INTEGER,
  thinking_tokens        INTEGER,
  prompt_tokens          INTEGER,
  image_blocks           INTEGER,
  cache_control_blocks   INTEGER,
  system_blocks          INTEGER,
  system_chars           INTEGER,
  tools_count            INTEGER,
  tools_chars            INTEGER,
  messages_count         INTEGER,
  system_sha256          TEXT,
  system_static_sha256   TEXT,
  system_dynamic_sha256  TEXT
);
CREATE INDEX IF NOT EXISTS model_requests_batch ON model_requests(batch_id);
CREATE INDEX IF NOT EXISTS model_requests_run ON model_requests(run_id);
CREATE INDEX IF NOT EXISTS model_requests_ts ON model_requests(ts);

CREATE TABLE IF NOT EXISTS run_usage (
  batch_id             TEXT NOT NULL,
  usage_id             INTEGER,
  run_id               TEXT,
  workspace_id         TEXT,
  bot_id               TEXT,
  attempt              INTEGER,
  model                TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_read_tokens    INTEGER,
  cache_create_tokens  INTEGER,
  cost_usd             REAL
);
CREATE INDEX IF NOT EXISTS run_usage_batch ON run_usage(batch_id);
CREATE INDEX IF NOT EXISTS run_usage_run ON run_usage(run_id);

CREATE TABLE IF NOT EXISTS task_runs (
  batch_id      TEXT NOT NULL,
  task_id       TEXT,
  ordinal       INTEGER,
  run_id        TEXT,
  workspace_id  TEXT
);
CREATE INDEX IF NOT EXISTS task_runs_batch ON task_runs(batch_id);
CREATE INDEX IF NOT EXISTS task_runs_run ON task_runs(run_id);

CREATE TABLE IF NOT EXISTS run_marks (
  batch_id      TEXT NOT NULL,
  observed_at   TEXT,
  run_id        TEXT,
  workspace_id  TEXT,
  verdict       TEXT,
  note          TEXT,
  marked_by     TEXT,
  marked_at     TEXT
);
CREATE INDEX IF NOT EXISTS run_marks_batch ON run_marks(batch_id);
CREATE INDEX IF NOT EXISTS run_marks_run ON run_marks(run_id, batch_id, observed_at);

CREATE TABLE IF NOT EXISTS run_summaries (
  batch_id        TEXT NOT NULL,
  run_id          TEXT,
  source_version  TEXT,
  workspace_id    TEXT,
  status          TEXT,
  text            TEXT,
  created_at      TEXT,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS run_summaries_batch ON run_summaries(batch_id);
CREATE INDEX IF NOT EXISTS run_summaries_run ON run_summaries(run_id, updated_at);

CREATE TABLE IF NOT EXISTS approval_decisions (
  batch_id      TEXT NOT NULL,
  approval_id   TEXT,
  run_id        TEXT,
  workspace_id  TEXT,
  bot_id        TEXT,
  thread_id     TEXT,
  kind          TEXT,
  risk_level    TEXT,
  tool_name     TEXT,
  wait_mode     TEXT,
  decision      TEXT,
  decided_by    TEXT,
  decider_kind  TEXT,
  rule_id       TEXT,
  created_at    TEXT,
  decided_at    TEXT,
  wait_ms       REAL
);
CREATE INDEX IF NOT EXISTS approval_decisions_batch ON approval_decisions(batch_id);
CREATE INDEX IF NOT EXISTS approval_decisions_run ON approval_decisions(run_id);

-- Every approval once created (amendment 2 decision 22); one without a decision row is pending.
CREATE TABLE IF NOT EXISTS approval_requests (
  batch_id      TEXT NOT NULL,
  approval_id   TEXT,
  run_id        TEXT,
  workspace_id  TEXT,
  bot_id        TEXT,
  thread_id     TEXT,
  kind          TEXT,
  risk_level    TEXT,
  tool_name     TEXT,
  wait_mode     TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS approval_requests_batch ON approval_requests(batch_id);
CREATE INDEX IF NOT EXISTS approval_requests_approval ON approval_requests(approval_id);
CREATE INDEX IF NOT EXISTS approval_requests_created ON approval_requests(created_at);

-- The failure retrospective (ADR-0046 decision 9, amendment 2 decisions 23 to 25). Written by the
-- Gateway module through the sink's vector store, never by a batch, so no batch_id. `vector` is
-- the L2-normalised embedding as little-endian float32; similarity is computed in the Gateway.
CREATE TABLE IF NOT EXISTS run_vectors (
  run_id           TEXT NOT NULL,
  source_version   TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  failure_class    TEXT,
  embedding_model  TEXT NOT NULL,
  dims             INTEGER NOT NULL,
  vector           BLOB NOT NULL,
  finished_at      TEXT,
  embedded_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_vectors_run_model ON run_vectors(run_id, embedding_model);
CREATE INDEX IF NOT EXISTS run_vectors_workspace
  ON run_vectors(workspace_id, embedding_model, outcome);

CREATE TABLE IF NOT EXISTS retrospective_matches (
  failed_run_id    TEXT NOT NULL,
  source_version   TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,
  embedding_model  TEXT NOT NULL,
  rank             INTEGER NOT NULL,
  match_run_id     TEXT NOT NULL,
  similarity       REAL NOT NULL,
  computed_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS retrospective_matches_rank
  ON retrospective_matches(failed_run_id, embedding_model, rank);
CREATE INDEX IF NOT EXISTS retrospective_matches_match ON retrospective_matches(match_run_id);

CREATE TABLE IF NOT EXISTS retrospective_state (
  key    TEXT NOT NULL PRIMARY KEY,
  value  TEXT
);

CREATE TABLE IF NOT EXISTS ingest_batches (
  token         TEXT NOT NULL,
  batch_id      TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  source_first  TEXT,
  source_last   TEXT,
  opened_at     TEXT,
  closed_at     TEXT,
  committed_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ingest_batches_token ON ingest_batches(token);
CREATE INDEX IF NOT EXISTS ingest_batches_table ON ingest_batches(table_name, batch_id);
CREATE INDEX IF NOT EXISTS ingest_batches_batch ON ingest_batches(batch_id);

-- Views. Dropped first so a changed definition replaces the old one.

DROP VIEW IF EXISTS watermarks;
DROP VIEW IF EXISTS failure_matches;
DROP VIEW IF EXISTS approval_requests_named;
DROP VIEW IF EXISTS approval_waits;
DROP VIEW IF EXISTS run_metrics;
DROP VIEW IF EXISTS request_cache;
DROP VIEW IF EXISTS requests_named;
DROP VIEW IF EXISTS model_latency;
DROP VIEW IF EXISTS model_request_timing;
DROP VIEW IF EXISTS phase_spans;
DROP VIEW IF EXISTS tool_calls;
DROP VIEW IF EXISTS runs_named;
DROP VIEW IF EXISTS runs_latest;

-- The newest snapshot of every run.
CREATE VIEW runs_latest AS
SELECT batch_id, observed_at, run_id, workspace_id, bot_id, thread_id, lane, trigger_kind,
       run_type, status, terminal, attempt, model, cheap_model, error, failure_class,
       created_at, started_at, finished_at, queue_ms, duration_ms
  FROM (SELECT s.*, ROW_NUMBER() OVER (
                 PARTITION BY run_id ORDER BY batch_id DESC, observed_at DESC) AS rn
          FROM run_states s)
 WHERE rn = 1;

-- Each run with the names of its bot, workspace and thread, its mark and its Activity summary.
CREATE VIEW runs_named AS
WITH bots AS (
  SELECT bot_id, name, role FROM (
    SELECT b.*, ROW_NUMBER() OVER (PARTITION BY bot_id ORDER BY batch_id DESC, observed_at DESC) AS rn
      FROM bot_states b) WHERE rn = 1),
workspaces AS (
  SELECT workspace_id, name FROM (
    SELECT w.*, ROW_NUMBER() OVER (
             PARTITION BY workspace_id ORDER BY batch_id DESC, observed_at DESC) AS rn
      FROM workspace_states w) WHERE rn = 1),
threads AS (
  SELECT thread_id, kind, title, private FROM (
    SELECT t.*, ROW_NUMBER() OVER (
             PARTITION BY thread_id ORDER BY batch_id DESC, observed_at DESC) AS rn
      FROM thread_states t) WHERE rn = 1),
marks AS (
  SELECT run_id, verdict, note FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY batch_id DESC, observed_at DESC) AS rn
      FROM run_marks m) WHERE rn = 1),
summaries AS (
  SELECT run_id, text FROM (
    SELECT s.*, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY updated_at DESC, batch_id DESC) AS rn
      FROM run_summaries s WHERE s.status = 'ready') WHERE rn = 1)
SELECT r.run_id, r.workspace_id, w.name AS workspace_name, r.bot_id, b.name AS bot_name,
       b.role AS bot_role, r.thread_id, t.title AS thread_title, t.kind AS thread_kind,
       t.private AS thread_private, r.lane, r.trigger_kind, r.run_type, r.status, r.terminal,
       r.attempt, r.model, r.cheap_model, r.error, r.failure_class, r.created_at, r.started_at,
       r.finished_at, r.queue_ms, r.duration_ms,
       CASE WHEN m.verdict = 'wrong' THEN 1 ELSE 0 END AS marked_wrong,
       CASE WHEN m.verdict = 'wrong' THEN m.note END AS mark_note,
       s.text AS summary
  FROM runs_latest r
  LEFT JOIN bots b ON b.bot_id = r.bot_id
  LEFT JOIN workspaces w ON w.workspace_id = r.workspace_id
  LEFT JOIN threads t ON t.thread_id = r.thread_id
  LEFT JOIN marks m ON m.run_id = r.run_id
  LEFT JOIN summaries s ON s.run_id = r.run_id;

-- Every tool call with its result, if one arrived. `outcome` is ok, error or no_result.
CREATE VIEW tool_calls AS
SELECT c.run_id, c.workspace_id, c.bot_id, c.attempt, c.tool_use_id, c.tool_name, c.risk_level,
       c.ts AS called_at, r.ts AS result_at, r.duration_ms, r.is_error,
       CASE WHEN r.event_id IS NULL THEN 'no_result'
            WHEN r.is_error = 1 THEN 'error'
            ELSE 'ok' END AS outcome
  FROM run_events c
  LEFT JOIN run_events r
    ON r.run_id = c.run_id AND r.tool_use_id = c.tool_use_id AND r.kind = 'tool_result'
 WHERE c.kind = 'tool_call';

-- Completed phase-timing spans (contracts `timing.ts`); a span without an end is not here.
-- `model` is the request's model on a model proxy span (amendment 2 decision 21), else null.
CREATE VIEW phase_spans AS
SELECT run_id, workspace_id, bot_id, attempt, span_id, parent_span_id, phase, tool_name,
       request_kind, model, outcome, ts AS ended_at, duration_ms
  FROM run_events
 WHERE source = 'phase_timing' AND edge = 'end';

-- Model proxy spans with the run's configured model.
CREATE VIEW model_request_timing AS
SELECT p.run_id, p.workspace_id, p.bot_id, p.attempt, p.span_id, p.parent_span_id, p.phase,
       p.request_kind, p.model, p.outcome, p.ended_at, p.duration_ms, r.model AS run_model,
       r.run_type
  FROM phase_spans p
  LEFT JOIN runs_latest r ON r.run_id = p.run_id
 WHERE p.phase IN ('model_request', 'model_headers', 'model_first_byte', 'model_body',
                   'proxy_queue');

-- One row per model proxy request (its `model_request` span) with its child spans: time to the
-- response headers, time to the first body byte (null when no byte came, never 0) and body time.
-- `model` is the span's own; a span recorded before the proxy named it falls back to the run's
-- model, and `model_source` says which (amendment 2 decision 21).
CREATE VIEW model_latency AS
WITH children AS (
  SELECT run_id, parent_span_id,
         max(CASE WHEN phase = 'model_headers' AND outcome = 'ok' THEN duration_ms END)
           AS headers_ms,
         max(CASE WHEN phase = 'model_first_byte' AND outcome = 'ok' THEN duration_ms END)
           AS first_byte_ms,
         max(CASE WHEN phase = 'model_body' THEN duration_ms END) AS body_ms
    FROM phase_spans
   WHERE phase IN ('model_headers', 'model_first_byte', 'model_body')
     AND parent_span_id IS NOT NULL
   GROUP BY run_id, parent_span_id)
SELECT p.run_id, p.workspace_id, n.workspace_name, p.bot_id, n.bot_name, p.attempt, p.span_id,
       coalesce(p.request_kind, 'unknown') AS request_kind,
       coalesce(p.model, n.model, 'unknown') AS model,
       CASE WHEN p.model IS NOT NULL THEN 'request' ELSE 'run' END AS model_source,
       p.outcome, p.ended_at, p.duration_ms, c.headers_ms, c.first_byte_ms, c.body_ms,
       n.run_type, n.trigger_kind
  FROM phase_spans p
  LEFT JOIN children c ON c.run_id = p.run_id AND c.parent_span_id = p.span_id
  LEFT JOIN runs_named n ON n.run_id = p.run_id
 WHERE p.phase = 'model_request';

-- Every model request with bot and workspace names and the run's kind.
CREATE VIEW requests_named AS
SELECT q.request_id, q.run_id, q.workspace_id, n.workspace_name, q.bot_id, n.bot_name,
       n.run_type, n.trigger_kind, n.status AS run_status, n.failure_class, q.attempt, q.seq,
       q.ts, q.request_kind, q.model, q.served_model, q.rewritten_from, q.refusal, q.stream,
       q.input_tokens, q.output_tokens, q.cache_read_tokens, q.cache_create_tokens,
       q.thinking_tokens, q.prompt_tokens, q.image_blocks, q.cache_control_blocks,
       q.system_blocks, q.system_chars, q.tools_count, q.tools_chars, q.messages_count,
       q.system_sha256, q.system_static_sha256, q.system_dynamic_sha256
  FROM model_requests q
  LEFT JOIN runs_named n ON n.run_id = q.run_id;

-- One row per inference request with what its provider reported about the prompt cache
-- (amendment 2 decision 20). A request without a cache-read count is `not_reported` and has no
-- share: it is never a miss and never a 0 % hit rate.
CREATE VIEW request_cache AS
SELECT request_id, run_id, workspace_id, workspace_name, bot_id, bot_name, ts, model,
       served_model,
       CASE WHEN refusal IS NOT NULL THEN 'refused'
            WHEN input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL
                 AND cache_create_tokens IS NULL THEN 'no_usage'
            WHEN cache_read_tokens IS NULL THEN 'not_reported'
            WHEN cache_read_tokens > 0 THEN 'hit'
            WHEN coalesce(cache_create_tokens, 0) > 0 THEN 'write'
            ELSE 'miss' END AS cache_status,
       CASE WHEN cache_read_tokens IS NOT NULL THEN 1 ELSE 0 END AS cache_reported,
       input_tokens, cache_read_tokens, cache_create_tokens,
       CASE WHEN cache_read_tokens IS NOT NULL THEN prompt_tokens END AS reported_prompt_tokens,
       CASE WHEN cache_read_tokens IS NOT NULL AND prompt_tokens > 0
            THEN 1.0 * cache_read_tokens / prompt_tokens END AS cache_read_share,
       cache_control_blocks, system_static_sha256
  FROM requests_named
 WHERE request_kind = 'messages';

-- One row per run: its latest state with tool, request, token, cost and approval totals.
CREATE VIEW run_metrics AS
WITH tools AS (
  SELECT run_id, count(*) AS calls,
         sum(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors
    FROM run_events WHERE kind = 'tool_result' GROUP BY run_id),
requests AS (
  SELECT run_id, count(*) AS requests,
         sum(CASE WHEN refusal IS NOT NULL THEN 1 ELSE 0 END) AS refused
    FROM model_requests WHERE request_kind = 'messages' GROUP BY run_id),
usage AS (
  SELECT run_id, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
         sum(cache_read_tokens) AS cache_read_tokens,
         sum(cache_create_tokens) AS cache_create_tokens, sum(cost_usd) AS cost_usd,
         sum(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_models
    FROM run_usage GROUP BY run_id),
approvals AS (
  SELECT run_id, count(*) AS approvals, sum(wait_ms) AS approval_wait_ms,
         sum(CASE WHEN decision = 'deny' THEN 1 ELSE 0 END) AS denied
    FROM approval_decisions GROUP BY run_id)
SELECT n.run_id, n.workspace_id, n.workspace_name, n.bot_id, n.bot_name, n.lane,
       n.trigger_kind, n.run_type, n.status, n.terminal, n.failure_class, n.model,
       n.created_at, n.finished_at, n.queue_ms, n.duration_ms, n.marked_wrong,
       coalesce(t.calls, 0) AS tool_calls, coalesce(t.errors, 0) AS tool_errors,
       coalesce(q.requests, 0) AS model_requests, coalesce(q.refused, 0) AS refused_requests,
       coalesce(u.input_tokens, 0) AS input_tokens, coalesce(u.output_tokens, 0) AS output_tokens,
       coalesce(u.cache_read_tokens, 0) AS cache_read_tokens,
       coalesce(u.cache_create_tokens, 0) AS cache_create_tokens, u.cost_usd,
       coalesce(u.unpriced_models, 0) AS unpriced_models,
       coalesce(a.approvals, 0) AS approvals, coalesce(a.denied, 0) AS approvals_denied,
       coalesce(a.approval_wait_ms, 0) AS approval_wait_ms
  FROM runs_named n
  LEFT JOIN tools t ON t.run_id = n.run_id
  LEFT JOIN requests q ON q.run_id = n.run_id
  LEFT JOIN usage u ON u.run_id = n.run_id
  LEFT JOIN approvals a ON a.run_id = n.run_id;

-- Decided approvals with names and how long the thread waited. `decider_group` (amendment 2
-- decision 22): `expired` for `system:expiry`, `human` for a person, `closed` for another system
-- actor (the run ended), else the kind of decider.
CREATE VIEW approval_waits AS
SELECT d.approval_id, d.run_id, d.workspace_id, n.workspace_name, d.bot_id, n.bot_name,
       d.thread_id, d.kind, d.risk_level, d.tool_name, d.wait_mode, d.decision, d.decided_by,
       d.decider_kind,
       CASE WHEN d.decided_by = 'system:expiry' THEN 'expired'
            WHEN d.decider_kind IN ('human', 'user') THEN 'human'
            WHEN d.decider_kind IN ('reviewer', 'rule', 'mode', 'bot') THEN d.decider_kind
            WHEN d.decider_kind = 'system' THEN 'closed'
            ELSE 'other' END AS decider_group,
       d.rule_id, d.created_at, d.decided_at, d.wait_ms
  FROM approval_decisions d
  LEFT JOIN runs_named n ON n.run_id = d.run_id;

-- Every approval request with its decision, if any. `state` is `decided`, `pending` (no decision
-- and the run still open) or `unknown` (no decision in the obs model although the run ended).
CREATE VIEW approval_requests_named AS
WITH requests AS (
  SELECT * FROM (
    SELECT q.*, ROW_NUMBER() OVER (PARTITION BY approval_id ORDER BY batch_id) AS rn
      FROM approval_requests q) WHERE rn = 1),
decisions AS (
  SELECT * FROM (
    SELECT w.*, ROW_NUMBER() OVER (PARTITION BY approval_id ORDER BY decided_at DESC) AS rn
      FROM approval_waits w) WHERE rn = 1)
SELECT q.approval_id, q.run_id, q.workspace_id, n.workspace_name, q.bot_id, n.bot_name,
       q.thread_id, q.kind, q.risk_level, q.tool_name, q.wait_mode, q.created_at,
       CASE WHEN d.approval_id IS NOT NULL THEN 'decided'
            WHEN coalesce(n.terminal, 0) = 1 THEN 'unknown'
            ELSE 'pending' END AS state,
       d.decision, d.decided_by, d.decider_group, d.decided_at, d.wait_ms, n.status AS run_status
  FROM requests q
  LEFT JOIN decisions d ON d.approval_id = q.approval_id
  LEFT JOIN runs_named n ON n.run_id = q.run_id;

-- The failure retrospective (amendment 2 decision 25): each failed run's nearest succeeded runs
-- of its workspace with their similarity. A match whose run has since been marked wrong is not
-- offered, and no private chat's run is on either side (decision 17).
CREATE VIEW failure_matches AS
SELECT m.failed_run_id, f.workspace_id, f.workspace_name, f.bot_name,
       coalesce(f.failure_class, 'unclassified') AS failure_class, f.created_at AS failed_at,
       f.error AS failed_error, f.summary AS failed_summary, m.rank, m.match_run_id,
       s.bot_name AS match_bot_name, s.created_at AS match_created_at,
       s.summary AS match_summary, m.similarity, m.embedding_model, m.computed_at
  FROM retrospective_matches m
  JOIN runs_named f ON f.run_id = m.failed_run_id
  JOIN runs_named s ON s.run_id = m.match_run_id
 WHERE s.marked_wrong = 0
   AND coalesce(s.thread_private, 0) = 0
   AND coalesce(f.thread_private, 0) = 0;

-- Per table: the batches and rows committed, and the collector's cursor after the newest one.
CREATE VIEW watermarks AS
SELECT i.table_name, totals.batches, totals.rows, i.batch_id AS last_batch_id,
       i.source_last AS last_source, i.closed_at AS last_closed_at,
       i.committed_at AS last_committed_at
  FROM ingest_batches i
  JOIN (SELECT table_name, count(*) AS batches, sum(row_count) AS rows,
               max(batch_id) AS last_batch
          FROM ingest_batches GROUP BY table_name) totals
    ON totals.table_name = i.table_name AND totals.last_batch = i.batch_id;
