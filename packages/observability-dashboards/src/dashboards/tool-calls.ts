// Tool calls (ADR-0046 amendment 2 decision 18): how many tool calls bots make, how often they
// fail, how long they take, which tools fail most, and per bot. Read from `tool_calls`, one row
// per call with its result if one arrived; names come from `runs_named`.

import { percentiles } from "../percentiles.js";
import { type DashboardSpec, inRange } from "../spec.js";

const called = inRange("called_at");
const calledC = inRange("c.called_at");
/** Calls that got a result: the denominator of an error rate and the input of a duration. */
const answered = `outcome <> 'no_result' AND ${called}`;

/** The MCP server of `mcp__<server>__<tool>`; built-in tools have none. */
const FAMILY = "^mcp__(.+?)__";

export const toolCalls: DashboardSpec = {
  uid: "deskmates-tool-calls",
  slug: "tool-calls",
  title: "Tool calls",
  description:
    "Tool call volume, error rate and duration across every workspace, the tools that fail most, and every bot's calls. Read from the obs model (ADR-0046).",
  from: "now-24h",
  variables: [],
  sections: [
    {
      title: "Overview",
      panels: [
        {
          title: "Tool calls",
          description: "Tool calls made in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () => `SELECT count(*) AS calls FROM tool_calls WHERE ${called}`,
        },
        {
          title: "Tool error rate",
          description: "Calls whose result was an error, as a share of calls that got a result.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "percent",
          sql: () =>
            `SELECT 100.0 * sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) / nullif(count(*), 0) AS error_rate FROM tool_calls WHERE ${answered}`,
        },
        {
          title: "Calls without a result",
          description: "Calls whose run ended, or is still going, without a result for them.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT count(*) AS no_result FROM tool_calls WHERE outcome = 'no_result' AND ${called}`,
        },
        {
          title: "Median duration",
          description: "Median time from a call to its result.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: () =>
            `SELECT p50 AS median_ms FROM (${percentiles({
              from: `SELECT duration_ms FROM tool_calls WHERE ${answered}`,
              value: "duration_ms",
              ps: [50],
            })}) q`,
        },
        {
          title: "p95 duration",
          description: "95 % of calls got their result within this time.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: () =>
            `SELECT p95 AS p95_ms FROM (${percentiles({
              from: `SELECT duration_ms FROM tool_calls WHERE ${answered}`,
              value: "duration_ms",
              ps: [95],
            })}) q`,
        },
        {
          title: "Bots calling tools",
          description: "Bots that made at least one tool call in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () => `SELECT count(DISTINCT bot_id) AS bots FROM tool_calls WHERE ${called}`,
        },
      ],
    },
    {
      title: "Over time",
      panels: [
        {
          title: "Tool calls per hour by outcome",
          description: "Tool calls per hour, stacked by ok, error and no result.",
          kind: "timeseries",
          style: "stacked-bars",
          w: 12,
          h: 8,
          unit: "short",
          sql: (d) =>
            `SELECT ${d.hourBucket("called_at")} AS time, outcome, count(*) AS calls FROM tool_calls WHERE ${called} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
        {
          title: "Error rate per hour",
          description: "Errors as a share of the calls that got a result, per hour.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "percent",
          sql: (d) =>
            `SELECT ${d.hourBucket("called_at")} AS time, 100.0 * sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) / nullif(count(*), 0) AS error_rate FROM tool_calls WHERE ${answered} GROUP BY 1 ORDER BY 1`,
        },
        {
          title: "p95 duration per hour by tool family",
          description:
            "The 95th percentile of call duration per hour, one line per MCP server; tools of the agent loop itself are built-in.",
          kind: "timeseries",
          style: "lines",
          w: 24,
          h: 8,
          unit: "ms",
          sql: (d) =>
            `SELECT time, family, p95 FROM (${percentiles({
              from: `SELECT ${d.hourBucket("called_at")} AS time, coalesce(${d.regexExtract("tool_name", FAMILY)}, 'built-in') AS family, duration_ms FROM tool_calls WHERE tool_name IS NOT NULL AND ${answered}`,
              value: "duration_ms",
              by: ["time", "family"],
              ps: [95],
            })}) q ORDER BY time, family`,
        },
      ],
    },
    {
      title: "Tools",
      panels: [
        {
          title: "Top failing tools",
          description:
            "The tools with the most errors in the time range, their error rate and the runs affected.",
          kind: "table",
          w: 12,
          h: 10,
          unit: "short",
          columnUnits: { error_rate: "percent" },
          sql: () =>
            `SELECT tool_name, sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors, count(*) AS calls, 100.0 * sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) / nullif(sum(CASE WHEN outcome <> 'no_result' THEN 1 ELSE 0 END), 0) AS error_rate, count(DISTINCT CASE WHEN outcome = 'error' THEN run_id END) AS runs, max(CASE WHEN outcome = 'error' THEN called_at END) AS last_error FROM tool_calls WHERE tool_name IS NOT NULL AND ${called} GROUP BY tool_name HAVING sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) > 0 ORDER BY errors DESC, tool_name LIMIT 20`,
        },
        {
          title: "Tool families",
          description:
            "Calls and errors per MCP server; tools of the agent loop itself are built-in.",
          kind: "table",
          w: 12,
          h: 10,
          unit: "short",
          sql: (d) =>
            `SELECT coalesce(${d.regexExtract("tool_name", FAMILY)}, 'built-in') AS family, count(*) AS calls, sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors FROM tool_calls WHERE tool_name IS NOT NULL AND ${called} GROUP BY 1 ORDER BY calls DESC, family`,
        },
        {
          title: "Tools",
          description:
            "Per tool: calls, errors, calls without a result, error rate and the median, p95 and longest time from call to result.",
          kind: "table",
          w: 24,
          h: 10,
          unit: "short",
          columnUnits: {
            error_rate: "percent",
            p50_ms: "ms",
            p95_ms: "ms",
            max_duration_ms: "ms",
          },
          sql: (d) =>
            `SELECT t.tool_name, t.family, t.calls, t.errors, t.no_result, 100.0 * t.errors / nullif(t.calls - t.no_result, 0) AS error_rate, q.p50 AS p50_ms, q.p95 AS p95_ms, t.max_duration_ms FROM (SELECT tool_name, coalesce(${d.regexExtract("tool_name", FAMILY)}, 'built-in') AS family, count(*) AS calls, sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors, sum(CASE WHEN outcome = 'no_result' THEN 1 ELSE 0 END) AS no_result, max(duration_ms) AS max_duration_ms FROM tool_calls WHERE tool_name IS NOT NULL AND ${called} GROUP BY tool_name) t LEFT JOIN (${percentiles(
              {
                from: `SELECT tool_name, duration_ms FROM tool_calls WHERE tool_name IS NOT NULL AND ${answered}`,
                value: "duration_ms",
                by: ["tool_name"],
                ps: [50, 95],
              },
            )}) q ON q.tool_name = t.tool_name ORDER BY t.calls DESC, t.tool_name LIMIT 100`,
        },
      ],
    },
    {
      title: "Per bot",
      panels: [
        {
          title: "Bots",
          description:
            "Per bot: calls, errors, error rate, calls without a result, distinct tools, and the median and p95 duration.",
          kind: "table",
          w: 24,
          h: 9,
          unit: "short",
          columnUnits: { error_rate: "percent", p50_ms: "ms", p95_ms: "ms" },
          sql: () =>
            `SELECT b.workspace_name, b.bot_name, b.calls, b.errors, 100.0 * b.errors / nullif(b.calls - b.no_result, 0) AS error_rate, b.no_result, b.tools, q.p50 AS p50_ms, q.p95 AS p95_ms FROM (SELECT coalesce(c.bot_id, '') AS bot_key, max(n.workspace_name) AS workspace_name, max(coalesce(n.bot_name, c.bot_id)) AS bot_name, count(*) AS calls, sum(CASE WHEN c.outcome = 'error' THEN 1 ELSE 0 END) AS errors, sum(CASE WHEN c.outcome = 'no_result' THEN 1 ELSE 0 END) AS no_result, count(DISTINCT c.tool_name) AS tools FROM tool_calls c LEFT JOIN runs_named n ON n.run_id = c.run_id WHERE ${calledC} GROUP BY 1) b LEFT JOIN (${percentiles(
              {
                from: `SELECT coalesce(bot_id, '') AS bot_key, duration_ms FROM tool_calls WHERE ${answered}`,
                value: "duration_ms",
                by: ["bot_key"],
                ps: [50, 95],
              },
            )}) q ON q.bot_key = b.bot_key ORDER BY b.calls DESC, b.bot_name`,
        },
        {
          title: "Tool errors by bot",
          description: "Which bot's calls of which tool failed, and in how many runs.",
          kind: "table",
          w: 12,
          h: 9,
          unit: "short",
          sql: () =>
            `SELECT n.workspace_name, n.bot_name, c.tool_name, count(*) AS errors, count(DISTINCT c.run_id) AS runs, max(c.called_at) AS last_seen FROM tool_calls c LEFT JOIN runs_named n ON n.run_id = c.run_id WHERE c.outcome = 'error' AND ${calledC} GROUP BY 1, 2, 3 ORDER BY errors DESC, last_seen DESC LIMIT 50`,
        },
        {
          title: "Newest errors",
          description: "The newest calls whose result was an error. A run id opens the run view.",
          kind: "table",
          w: 12,
          h: 9,
          unit: "short",
          columnUnits: { duration_ms: "ms" },
          runLinks: ["run_id"],
          sql: () =>
            `SELECT c.called_at, n.bot_name, c.tool_name, c.duration_ms, n.status AS run_status, c.run_id FROM tool_calls c LEFT JOIN runs_named n ON n.run_id = c.run_id WHERE c.outcome = 'error' AND ${calledC} ORDER BY c.called_at DESC LIMIT 50`,
        },
        {
          title: "Calls without a result",
          description:
            "The newest calls that never got a result, with the run's status. A run id opens the run view.",
          kind: "table",
          w: 24,
          h: 9,
          unit: "short",
          runLinks: ["run_id"],
          sql: () =>
            `SELECT c.called_at, n.bot_name, c.tool_name, n.status AS run_status, c.run_id FROM tool_calls c LEFT JOIN runs_named n ON n.run_id = c.run_id WHERE c.outcome = 'no_result' AND ${calledC} ORDER BY c.called_at DESC LIMIT 50`,
        },
      ],
    },
  ],
};
