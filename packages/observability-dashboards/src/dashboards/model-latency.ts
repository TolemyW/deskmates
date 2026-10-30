// Model latency (ADR-0046 amendment 2 decision 18): how long model requests take through the
// Gateway's model proxy, per model and request kind. Time to first byte is transport latency (the
// first response body byte), not the first generated token; request duration includes the
// network and the upstream's work (contracts `timing.ts`). Read from `model_latency`, one row per
// proxy request; a request recorded before the proxy named its model shows the run's model.

import { percentiles } from "../percentiles.js";
import { type DashboardSpec, inRange } from "../spec.js";

const ended = inRange("ended_at");
/** Inference only: a token count is a different, much shorter request. */
const inference = `request_kind = 'messages' AND ${ended}`;
const PS = [50, 90, 95, 99] as const;

export const modelLatency: DashboardSpec = {
  uid: "deskmates-model-latency",
  slug: "model-latency",
  title: "Model latency",
  description:
    "Model request duration and time to first byte through the Gateway's model proxy, per model and request kind, with percentiles over time and the slowest requests. Read from the obs model (ADR-0046).",
  from: "now-24h",
  variables: [],
  sections: [
    {
      title: "Overview (inference requests)",
      panels: [
        {
          title: "Inference requests",
          description: "Model proxy requests of kind messages that ended in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () => `SELECT count(*) AS requests FROM model_latency WHERE ${inference}`,
        },
        {
          title: "Median request duration",
          description: "From the proxy sending the request to the last response byte.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: () =>
            `SELECT p50 AS median_ms FROM (${percentiles({
              from: `SELECT duration_ms FROM model_latency WHERE ${inference}`,
              value: "duration_ms",
              ps: [50],
            })}) q`,
        },
        {
          title: "p95 request duration",
          description: "95 % of inference requests finished within this time.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: () =>
            `SELECT p95 AS p95_ms FROM (${percentiles({
              from: `SELECT duration_ms FROM model_latency WHERE ${inference}`,
              value: "duration_ms",
              ps: [95],
            })}) q`,
        },
        {
          title: "Median time to first byte",
          description:
            "From sending the request to the first response body byte. A request that returned no body byte has no value and is left out, never counted as 0.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: () =>
            `SELECT p50 AS median_ms FROM (${percentiles({
              from: `SELECT first_byte_ms FROM model_latency WHERE ${inference}`,
              value: "first_byte_ms",
              ps: [50],
            })}) q`,
        },
        {
          title: "p95 time to first byte",
          description: "95 % of inference requests saw their first body byte within this time.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: () =>
            `SELECT p95 AS p95_ms FROM (${percentiles({
              from: `SELECT first_byte_ms FROM model_latency WHERE ${inference}`,
              value: "first_byte_ms",
              ps: [95],
            })}) q`,
        },
        {
          title: "Failed or cancelled",
          description: "Inference requests that ended with an error or were cancelled, as a share.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "percent",
          sql: () =>
            `SELECT 100.0 * sum(CASE WHEN outcome = 'ok' THEN 0 ELSE 1 END) / nullif(count(*), 0) AS failed_share FROM model_latency WHERE ${inference}`,
        },
      ],
    },
    {
      title: "Percentiles over time",
      panels: [
        {
          title: "Request duration per hour (p50, p90, p95, p99)",
          description:
            "Percentiles of inference request duration for the requests that ended in each hour.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "ms",
          sql: (d) =>
            `SELECT time, p50, p90, p95, p99 FROM (${percentiles({
              from: `SELECT ${d.hourBucket("ended_at")} AS time, duration_ms FROM model_latency WHERE ${inference}`,
              value: "duration_ms",
              by: ["time"],
              ps: PS,
            })}) q ORDER BY time`,
        },
        {
          title: "Time to first byte per hour (p50, p90, p95, p99)",
          description:
            "Percentiles of time to first byte for the inference requests that ended in each hour.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "ms",
          sql: (d) =>
            `SELECT time, p50, p90, p95, p99 FROM (${percentiles({
              from: `SELECT ${d.hourBucket("ended_at")} AS time, first_byte_ms FROM model_latency WHERE ${inference}`,
              value: "first_byte_ms",
              by: ["time"],
              ps: PS,
            })}) q ORDER BY time`,
        },
        {
          title: "p95 request duration per hour by model",
          description: "The 95th percentile of inference request duration, one line per model.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "ms",
          sql: (d) =>
            `SELECT time, model, p95 FROM (${percentiles({
              from: `SELECT ${d.hourBucket("ended_at")} AS time, model, duration_ms FROM model_latency WHERE ${inference}`,
              value: "duration_ms",
              by: ["time", "model"],
              ps: [95],
            })}) q ORDER BY time, model`,
        },
        {
          title: "p95 time to first byte per hour by model",
          description: "The 95th percentile of time to first byte, one line per model.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "ms",
          sql: (d) =>
            `SELECT time, model, p95 FROM (${percentiles({
              from: `SELECT ${d.hourBucket("ended_at")} AS time, model, first_byte_ms FROM model_latency WHERE ${inference}`,
              value: "first_byte_ms",
              by: ["time", "model"],
              ps: [95],
            })}) q ORDER BY time, model`,
        },
        {
          title: "Failed and cancelled requests per hour by model",
          description: "Requests of every kind that ended with an error or were cancelled.",
          kind: "timeseries",
          style: "stacked-bars",
          w: 24,
          h: 7,
          unit: "short",
          sql: (d) =>
            `SELECT ${d.hourBucket("ended_at")} AS time, model, count(*) AS requests FROM model_latency WHERE outcome <> 'ok' AND ${ended} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
      ],
    },
    {
      title: "By model and request kind",
      panels: [
        {
          title: "Models",
          description:
            "Per model and request kind: requests, errors, cancellations, request duration percentiles and time to first byte. model_source run counts requests whose model is the run's, recorded before the proxy named it.",
          kind: "table",
          w: 24,
          h: 10,
          unit: "short",
          columnUnits: {
            p50_ms: "ms",
            p90_ms: "ms",
            p95_ms: "ms",
            p99_ms: "ms",
            first_byte_p50_ms: "ms",
            first_byte_p95_ms: "ms",
            headers_p50_ms: "ms",
          },
          sql: () =>
            `SELECT c.model, c.request_kind, c.requests, c.errors, c.cancelled, c.model_from_run, r.p50 AS p50_ms, r.p90 AS p90_ms, r.p95 AS p95_ms, r.p99 AS p99_ms, f.p50 AS first_byte_p50_ms, f.p95 AS first_byte_p95_ms, h.p50 AS headers_p50_ms FROM (SELECT model, request_kind, count(*) AS requests, sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors, sum(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled, sum(CASE WHEN model_source = 'run' THEN 1 ELSE 0 END) AS model_from_run FROM model_latency WHERE ${ended} GROUP BY model, request_kind) c LEFT JOIN (${percentiles(
              {
                from: `SELECT model, request_kind, duration_ms FROM model_latency WHERE ${ended}`,
                value: "duration_ms",
                by: ["model", "request_kind"],
                ps: PS,
              },
            )}) r ON r.model = c.model AND r.request_kind = c.request_kind LEFT JOIN (${percentiles(
              {
                from: `SELECT model, request_kind, first_byte_ms FROM model_latency WHERE ${ended}`,
                value: "first_byte_ms",
                by: ["model", "request_kind"],
                ps: [50, 95],
              },
            )}) f ON f.model = c.model AND f.request_kind = c.request_kind LEFT JOIN (${percentiles(
              {
                from: `SELECT model, request_kind, headers_ms FROM model_latency WHERE ${ended}`,
                value: "headers_ms",
                by: ["model", "request_kind"],
                ps: [50],
              },
            )}) h ON h.model = c.model AND h.request_kind = c.request_kind ORDER BY c.requests DESC, c.model, c.request_kind`,
        },
        {
          title: "Slowest requests",
          description:
            "The model requests that took longest in the time range, with their time to first byte. A run id opens the run view.",
          kind: "table",
          w: 24,
          h: 10,
          unit: "short",
          columnUnits: { duration_ms: "ms", first_byte_ms: "ms", headers_ms: "ms" },
          runLinks: ["run_id"],
          sql: () =>
            `SELECT ended_at, workspace_name, bot_name, model, model_source, request_kind, outcome, duration_ms, first_byte_ms, headers_ms, run_id FROM model_latency WHERE duration_ms IS NOT NULL AND ${ended} ORDER BY duration_ms DESC, ended_at DESC LIMIT 50`,
        },
      ],
    },
  ],
};
