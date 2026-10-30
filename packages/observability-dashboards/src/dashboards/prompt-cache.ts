// Prompt cache (ADR-0046 amendment 2 decisions 18 and 20): how much of each inference request's
// prompt was read from the provider's cache, per model, workspace and hour. A request whose
// provider reported usage without a cache-read count is `not_reported`: it is left out of every
// share and shown as its own band, never as a miss or a 0 % hit rate (the v0.7.3 acceptance
// found such a band reading as 0 %). Read from `request_cache`.

import { type DashboardSpec, inRange } from "../spec.js";

const sent = inRange("ts");
const reported = `cache_reported = 1 AND ${sent}`;
const SHARE = "100.0 * sum(cache_read_tokens) / nullif(sum(reported_prompt_tokens), 0)";
/** Per group: requests by cache status and the cache-read share of reporting requests. */
const GROUP_COLUMNS = [
  "count(*) AS requests",
  "sum(cache_reported) AS reporting",
  "sum(CASE WHEN cache_status = 'not_reported' THEN 1 ELSE 0 END) AS not_reported",
  "sum(CASE WHEN cache_status = 'no_usage' THEN 1 ELSE 0 END) AS no_usage",
  "sum(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS hits",
  "100.0 * sum(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) / nullif(sum(cache_reported), 0) AS hit_rate",
  "sum(CASE WHEN cache_reported = 1 THEN cache_read_tokens END) AS cache_read_tokens",
  "sum(reported_prompt_tokens) AS reported_prompt_tokens",
  `${SHARE} AS cache_read_share`,
  "sum(CASE WHEN cache_reported = 1 THEN cache_create_tokens END) AS cache_write_tokens",
].join(", ");

export const promptCache: DashboardSpec = {
  uid: "deskmates-prompt-cache",
  slug: "prompt-cache",
  title: "Prompt cache",
  description:
    "Cache-read share of inference requests per model, workspace and hour. Requests whose provider reported no cache count are shown as not reported and left out of every share. Read from the obs model (ADR-0046).",
  from: "now-24h",
  variables: [],
  sections: [
    {
      title: "Overview",
      panels: [
        {
          title: "Cache-read share",
          description:
            "Prompt tokens read from the cache as a share of all prompt tokens (input, cache read and cache write), over requests that reported a cache-read count.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "percent",
          sql: () => `SELECT ${SHARE} AS cache_read_share FROM request_cache WHERE ${reported}`,
        },
        {
          title: "Requests with a cache hit",
          description: "Reporting requests that read any tokens from the cache, as a share.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "percent",
          sql: () =>
            `SELECT 100.0 * sum(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) / nullif(count(*), 0) AS hit_rate FROM request_cache WHERE ${reported}`,
        },
        {
          title: "Reporting requests",
          description: "Inference requests whose provider reported a cache-read count, 0 included.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () => `SELECT count(*) AS reporting FROM request_cache WHERE ${reported}`,
        },
        {
          title: "Not reported",
          description:
            "Requests whose provider reported usage without a cache-read count. They are left out of every share on this dashboard; they are not misses.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT count(*) AS not_reported FROM request_cache WHERE cache_status = 'not_reported' AND ${sent}`,
        },
        {
          title: "No usage",
          description:
            "Requests with no usage at all: the response never reported it, or the run ended first.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT count(*) AS no_usage FROM request_cache WHERE cache_status = 'no_usage' AND ${sent}`,
        },
        {
          title: "Cache-write tokens",
          description: "Prompt tokens written to the cache by reporting requests.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT coalesce(sum(cache_create_tokens), 0) AS cache_write_tokens FROM request_cache WHERE ${reported}`,
        },
      ],
    },
    {
      title: "Over time",
      panels: [
        {
          title: "Cache-read share per hour by model",
          description:
            "The cache-read share of each model's reporting requests per hour. An hour with only not-reported requests has no point, never a 0.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "percent",
          sql: (d) =>
            `SELECT ${d.hourBucket("ts")} AS time, coalesce(model, 'unknown') AS model, ${SHARE} AS cache_read_share FROM request_cache WHERE ${reported} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
        {
          title: "Requests per hour by cache status",
          description:
            "Inference requests per hour stacked by hit, write, miss, not reported, no usage and refused. Not reported is its own band.",
          kind: "timeseries",
          style: "stacked-bars",
          w: 12,
          h: 8,
          unit: "short",
          sql: (d) =>
            `SELECT ${d.hourBucket("ts")} AS time, cache_status, count(*) AS requests FROM request_cache WHERE ${sent} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
        {
          title: "Cache-read share per hour by workspace",
          description: "The cache-read share of each workspace's reporting requests per hour.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "percent",
          sql: (d) =>
            `SELECT ${d.hourBucket("ts")} AS time, coalesce(workspace_name, workspace_id, 'unknown') AS workspace, ${SHARE} AS cache_read_share FROM request_cache WHERE ${reported} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
        {
          title: "Prompt tokens per hour",
          description:
            "Reporting requests' prompt tokens per hour: read from the cache, written to it, and uncached input.",
          kind: "timeseries",
          style: "stacked-bars",
          w: 12,
          h: 8,
          unit: "short",
          sql: (d) =>
            `SELECT ${d.hourBucket("ts")} AS time, sum(cache_read_tokens) AS cache_read, sum(coalesce(cache_create_tokens, 0)) AS cache_write, sum(coalesce(input_tokens, 0)) AS uncached_input FROM request_cache WHERE ${reported} GROUP BY 1 ORDER BY 1`,
        },
      ],
    },
    {
      title: "By model and workspace",
      panels: [
        {
          title: "Models",
          description:
            "Per model: requests by cache status, the hit rate and the cache-read share of reporting requests, and the tokens behind them.",
          kind: "table",
          w: 24,
          h: 9,
          unit: "short",
          columnUnits: { hit_rate: "percent", cache_read_share: "percent" },
          sql: () =>
            `SELECT coalesce(model, 'unknown') AS model, ${GROUP_COLUMNS} FROM request_cache WHERE ${sent} GROUP BY 1 ORDER BY requests DESC, model`,
        },
        {
          title: "Workspaces",
          description: "The same per workspace.",
          kind: "table",
          w: 24,
          h: 9,
          unit: "short",
          columnUnits: { hit_rate: "percent", cache_read_share: "percent" },
          sql: () =>
            `SELECT coalesce(workspace_name, workspace_id, 'unknown') AS workspace, ${GROUP_COLUMNS} FROM request_cache WHERE ${sent} GROUP BY 1 ORDER BY requests DESC, workspace`,
        },
        {
          title: "Where cache counts are not reported",
          description:
            "Requested and served models whose provider reported usage without a cache-read count, and when that was last seen. These requests are in no share above.",
          kind: "table",
          w: 24,
          h: 8,
          unit: "short",
          sql: () =>
            `SELECT coalesce(model, 'unknown') AS model, coalesce(served_model, '') AS served_model, count(*) AS requests, count(DISTINCT run_id) AS runs, max(ts) AS last_seen FROM request_cache WHERE cache_status = 'not_reported' AND ${sent} GROUP BY 1, 2 ORDER BY requests DESC, last_seen DESC LIMIT 50`,
        },
      ],
    },
  ],
};
