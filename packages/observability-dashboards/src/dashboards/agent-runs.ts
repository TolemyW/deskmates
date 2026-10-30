// Agent runs: which runs fail and why, what they cost, which bots they belong to, and one run in
// detail (the run view the web UI's run drawer links to). The demo's first finding, cheap-model
// jobs failing on a model the upstream did not serve, is the "Failures by class and model" and
// "Refused model requests" pair. The failure retrospective (ADR-0046 amendment 2 decisions 25 and
// 26) shows each failed run's nearest succeeded runs; its minimum similarity is a display filter.

import { NOW } from "../dialect.js";
import { type DashboardSpec, RUN_VIEW, inRange, variable } from "../spec.js";

const run = variable(RUN_VIEW.variable);
const created = inRange("created_at");
/** The display threshold: what is shown, never what is stored or decided (decision 26). */
const minSimilarity = `coalesce(CAST(nullif(${variable("min_similarity")}, '') AS REAL), 0)`;

export const agentRuns: DashboardSpec = {
  uid: RUN_VIEW.uid,
  slug: RUN_VIEW.slug,
  title: "Agent runs",
  description:
    "Runs across every workspace: outcomes, failures, cost and bots, and one run in detail. Read from the obs model (ADR-0046); the ledger is never read here.",
  from: "now-24h",
  variables: [
    {
      name: RUN_VIEW.variable,
      label: "Run id",
      description: "A run id for the One run section; the run drawer's Analytics link sets it.",
    },
    {
      name: "min_similarity",
      label: "Min similarity",
      description:
        "Failure retrospective: hide matches below this cosine similarity. A display filter only; every match is stored.",
      default: "0",
    },
  ],
  sections: [
    {
      title: "Overview",
      panels: [
        {
          title: "Runs",
          description: "Runs created in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () => `SELECT count(*) AS runs FROM run_metrics WHERE ${created}`,
        },
        {
          title: "Failed runs",
          description: "Runs created in the time range that ended failed.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT count(*) AS failed FROM run_metrics WHERE status = 'failed' AND ${created}`,
        },
        {
          title: "Failure rate",
          description: "Failed runs as a share of finished runs created in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "percent",
          sql: () =>
            `SELECT 100.0 * sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) / nullif(count(*), 0) AS failure_rate FROM run_metrics WHERE terminal = 1 AND ${created}`,
        },
        {
          title: "Median run time",
          description: "Median duration of finished runs created in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: (d) =>
            `SELECT median AS median_duration_ms FROM (${d.median({
              from: `SELECT duration_ms FROM run_metrics WHERE terminal = 1 AND ${created}`,
              value: "duration_ms",
            })}) m`,
        },
        {
          title: "Cost",
          description: "Priced usage of runs created in the time range; unpriced models count 0.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "currencyUSD",
          sql: () =>
            `SELECT coalesce(sum(cost_usd), 0) AS cost_usd FROM run_metrics WHERE ${created}`,
        },
        {
          title: "Marked wrong",
          description: "Runs a person marked wrong in the run drawer (ADR-0042).",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT coalesce(sum(marked_wrong), 0) AS marked_wrong FROM run_metrics WHERE ${created}`,
        },
      ],
    },
    {
      title: "Over time",
      panels: [
        {
          title: "Runs per hour by status",
          description: "Runs created per hour, stacked by their latest status.",
          kind: "timeseries",
          style: "stacked-bars",
          w: 12,
          h: 8,
          unit: "short",
          sql: (d) =>
            `SELECT ${d.hourBucket("created_at")} AS time, status, count(*) AS runs FROM run_metrics WHERE ${created} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
        {
          title: "Cost per hour by model",
          description: "Priced usage per hour of runs created then, by the run's model.",
          kind: "timeseries",
          style: "stacked-bars",
          w: 12,
          h: 8,
          unit: "currencyUSD",
          sql: (d) =>
            `SELECT ${d.hourBucket("created_at")} AS time, coalesce(model, 'unknown') AS model, sum(cost_usd) AS cost_usd FROM run_metrics WHERE cost_usd IS NOT NULL AND ${created} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
      ],
    },
    {
      title: "Where runs fail",
      panels: [
        {
          title: "Failures by class and model",
          description:
            "Failed runs grouped by failure class (ADR-0042), model, run type and trigger. A model the upstream does not serve shows here first.",
          kind: "table",
          w: 12,
          h: 9,
          unit: "short",
          sql: () =>
            `SELECT coalesce(failure_class, 'unclassified') AS failure_class, coalesce(model, '') AS model, run_type, trigger_kind, count(*) AS runs, max(created_at) AS last_seen FROM run_metrics WHERE status = 'failed' AND ${created} GROUP BY 1, 2, 3, 4 ORDER BY runs DESC, last_seen DESC LIMIT 50`,
        },
        {
          title: "Refused model requests",
          description:
            "Model requests the proxy refused, by requested and served model and the refusal.",
          kind: "table",
          w: 12,
          h: 9,
          unit: "short",
          sql: () =>
            `SELECT model, coalesce(served_model, '') AS served_model, refusal, count(*) AS requests, count(DISTINCT run_id) AS runs, max(ts) AS last_seen FROM requests_named WHERE refusal IS NOT NULL AND ${inRange("ts")} GROUP BY 1, 2, 3 ORDER BY requests DESC, last_seen DESC LIMIT 50`,
        },
        {
          title: "Bots",
          description:
            "Per bot: runs, failures, marks, median run time, tool errors and cost, for runs created in the time range.",
          kind: "table",
          w: 24,
          h: 9,
          unit: "short",
          columnUnits: { median_duration_ms: "ms", cost_usd: "currencyUSD" },
          sql: (d) =>
            `SELECT b.workspace_name, b.bot_name, b.runs, b.failed, b.marked_wrong, m.median AS median_duration_ms, b.tool_errors, b.cost_usd FROM (SELECT bot_id, max(workspace_name) AS workspace_name, max(bot_name) AS bot_name, count(*) AS runs, sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, sum(marked_wrong) AS marked_wrong, sum(tool_errors) AS tool_errors, sum(cost_usd) AS cost_usd FROM run_metrics WHERE ${created} GROUP BY bot_id) b LEFT JOIN (${d.median(
              {
                from: `SELECT bot_id, duration_ms FROM run_metrics WHERE terminal = 1 AND ${created}`,
                value: "duration_ms",
                by: ["bot_id"],
              },
            )}) m ON m.bot_id = b.bot_id ORDER BY b.runs DESC, b.bot_name LIMIT 200`,
        },
        {
          title: "Runs to look at",
          description:
            "The newest runs that failed, stayed silent, were cancelled or stopped, or were marked wrong. A run id opens it in One run below.",
          kind: "table",
          w: 24,
          h: 10,
          unit: "short",
          columnUnits: { duration_ms: "ms", cost_usd: "currencyUSD" },
          runLinks: ["run_id"],
          sql: () =>
            `SELECT created_at, workspace_name, bot_name, trigger_kind, run_type, model, status, failure_class, marked_wrong, tool_errors, refused_requests, duration_ms, cost_usd, run_id FROM run_metrics WHERE (status IN ('failed', 'silent', 'cancelled', 'stopped') OR marked_wrong = 1) AND ${created} ORDER BY created_at DESC LIMIT 100`,
        },
      ],
    },
    {
      title: "One run (set Run id above)",
      panels: [
        {
          title: "Run",
          description: "The run's latest state, totals, error, mark and Activity summary.",
          kind: "table",
          w: 24,
          h: 5,
          unit: "short",
          columnUnits: {
            queue_ms: "ms",
            duration_ms: "ms",
            approval_wait_ms: "ms",
            cost_usd: "currencyUSD",
          },
          sql: () =>
            `SELECT m.run_id, m.workspace_name, m.bot_name, m.trigger_kind, m.run_type, m.lane, m.status, m.failure_class, m.model, m.created_at, m.finished_at, m.queue_ms, m.duration_ms, m.tool_calls, m.tool_errors, m.model_requests, m.refused_requests, m.approvals, m.approval_wait_ms, m.cost_usd, n.error, n.mark_note, n.summary FROM run_metrics m LEFT JOIN runs_named n ON n.run_id = m.run_id WHERE m.run_id = ${run}`,
        },
        {
          title: "Tool calls",
          description: "The run's tool calls in order, with their outcome and time.",
          kind: "table",
          w: 12,
          h: 10,
          unit: "short",
          columnUnits: { duration_ms: "ms" },
          sql: () =>
            `SELECT called_at, tool_name, risk_level, outcome, duration_ms FROM tool_calls WHERE run_id = ${run} ORDER BY called_at, tool_use_id`,
        },
        {
          title: "Phases",
          description: "The run's completed phase-timing spans in the order they ended.",
          kind: "table",
          w: 12,
          h: 10,
          unit: "short",
          columnUnits: { duration_ms: "ms" },
          sql: () =>
            `SELECT ended_at, phase, tool_name, request_kind, outcome, duration_ms FROM phase_spans WHERE run_id = ${run} ORDER BY ended_at, span_id`,
        },
        {
          title: "Model requests",
          description: "The run's model requests with their shape and token counts.",
          kind: "table",
          w: 12,
          h: 8,
          unit: "short",
          sql: () =>
            `SELECT ts, request_kind, model, served_model, refusal, prompt_tokens, output_tokens, cache_read_tokens, messages_count, tools_count FROM requests_named WHERE run_id = ${run} ORDER BY ts, request_id`,
        },
        {
          title: "Nearest successful runs",
          description:
            "When this run failed: the succeeded runs of its workspace whose Activity summary is closest to its own (failure retrospective).",
          kind: "table",
          w: 12,
          h: 8,
          unit: "short",
          runLinks: ["match_run_id"],
          sql: () =>
            `SELECT rank, similarity, match_bot_name, match_created_at, match_summary, match_run_id FROM failure_matches WHERE failed_run_id = ${run} AND similarity >= ${minSimilarity} ORDER BY rank`,
        },
        {
          title: "Approvals",
          description: "The run's decided approvals and how long each waited.",
          kind: "table",
          w: 12,
          h: 8,
          unit: "short",
          columnUnits: { wait_ms: "ms" },
          sql: () =>
            `SELECT created_at, kind, tool_name, risk_level, decision, decided_by, wait_ms FROM approval_waits WHERE run_id = ${run} ORDER BY created_at, approval_id`,
        },
      ],
    },
    {
      title: "Failure retrospective",
      panels: [
        {
          title: "Failed runs with matches",
          description:
            "Failed runs created in the time range that have at least one nearest successful run at or above the minimum similarity.",
          kind: "stat",
          w: 6,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT count(DISTINCT failed_run_id) AS failed_runs FROM failure_matches WHERE similarity >= ${minSimilarity} AND ${inRange("failed_at")}`,
        },
        {
          title: "Median best similarity",
          description:
            "The median similarity of each failed run's closest match, over failed runs created in the time range.",
          kind: "stat",
          w: 6,
          h: 4,
          unit: "short",
          sql: (d) =>
            `SELECT median AS median_similarity FROM (${d.median({
              from: `SELECT similarity FROM failure_matches WHERE rank = 1 AND ${inRange("failed_at")}`,
              value: "similarity",
            })}) m`,
        },
        {
          title: "Matches by failure class",
          description:
            "Per failure class: failed runs with matches and the median similarity of their closest match.",
          kind: "table",
          w: 12,
          h: 4,
          unit: "short",
          sql: (d) =>
            `SELECT c.failure_class, c.failed_runs, m.median AS median_best_similarity FROM (SELECT failure_class, count(DISTINCT failed_run_id) AS failed_runs FROM failure_matches WHERE similarity >= ${minSimilarity} AND ${inRange("failed_at")} GROUP BY failure_class) c LEFT JOIN (${d.median(
              {
                from: `SELECT failure_class, similarity FROM failure_matches WHERE rank = 1 AND ${inRange("failed_at")}`,
                value: "similarity",
                by: ["failure_class"],
              },
            )}) m ON m.failure_class = c.failure_class ORDER BY c.failed_runs DESC, c.failure_class`,
        },
        {
          title: "Failure retrospective",
          description:
            "Each failed run with its nearest succeeded runs of the same workspace by Activity summary, most similar first. No private chat's run appears, and a run marked wrong is never offered. Either run id opens the run view.",
          kind: "table",
          w: 24,
          h: 12,
          unit: "short",
          runLinks: ["failed_run_id", "match_run_id"],
          sql: () =>
            `SELECT failed_at, workspace_name, bot_name, failure_class, coalesce(failed_summary, failed_error) AS failed_text, failed_run_id, rank, similarity, match_bot_name, match_created_at, match_summary, match_run_id FROM failure_matches WHERE similarity >= ${minSimilarity} AND failed_at IS NOT NULL AND ${inRange("failed_at")} ORDER BY failed_at DESC, failed_run_id, rank LIMIT 200`,
        },
      ],
    },
    {
      title: "Pipeline",
      panels: [
        {
          title: "Ingest watermarks",
          description:
            "Per obs table: batches and rows committed, the newest batch, and how long ago it was committed. A growing lag means the collector is behind.",
          kind: "table",
          w: 24,
          h: 7,
          unit: "short",
          columnUnits: { lag_ms: "ms" },
          sql: (d) =>
            `SELECT table_name, batches, rows, last_batch_id, last_closed_at, last_committed_at, ${d.timeDiffMs(NOW, "last_committed_at")} AS lag_ms FROM watermarks ORDER BY table_name`,
        },
      ],
    },
  ],
};
