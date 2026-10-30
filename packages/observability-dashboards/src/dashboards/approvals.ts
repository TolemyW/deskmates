// Approvals (ADR-0046 amendment 2 decisions 18 and 22): how long approvals wait, who decides them
// (a person, the AI reviewer, a stored rule, the workspace mode, a bot), what is pending now, what
// expired, per workspace. Requests come from `approval_requests_named` (every request, decided or
// not), decisions from `approval_waits`.

import { NOW } from "../dialect.js";
import { percentiles } from "../percentiles.js";
import { type DashboardSpec, inRange } from "../spec.js";

const requested = inRange("created_at");
const decided = inRange("decided_at");
const human = `decider_group = 'human' AND ${decided}`;

/** One approval's grouping keys, with NULL as '' so groups join on plain equality. */
const APPROVAL_KEYS =
  "coalesce(kind, '') AS kind, coalesce(risk_level, '') AS risk_level, coalesce(decider_group, '') AS decider_group, coalesce(decision, '') AS decision";

/** Requests of one workspace by how they ended. */
const BY_OUTCOME = [
  "count(*) AS requested",
  "sum(CASE WHEN state = 'decided' THEN 1 ELSE 0 END) AS decided",
  "sum(CASE WHEN decider_group = 'human' THEN 1 ELSE 0 END) AS by_human",
  "sum(CASE WHEN decider_group = 'reviewer' THEN 1 ELSE 0 END) AS by_reviewer",
  "sum(CASE WHEN decider_group = 'rule' THEN 1 ELSE 0 END) AS by_rule",
  "sum(CASE WHEN decider_group = 'mode' THEN 1 ELSE 0 END) AS by_mode",
  "sum(CASE WHEN decider_group = 'bot' THEN 1 ELSE 0 END) AS by_bot",
  "sum(CASE WHEN decider_group = 'expired' THEN 1 ELSE 0 END) AS expired",
  "sum(CASE WHEN decider_group = 'closed' THEN 1 ELSE 0 END) AS closed_with_run",
  "sum(CASE WHEN decision = 'deny' AND decider_group <> 'expired' AND decider_group <> 'closed' THEN 1 ELSE 0 END) AS denied",
  "sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending",
].join(", ");

export const approvals: DashboardSpec = {
  uid: "deskmates-approvals",
  slug: "approvals",
  title: "Approvals",
  description:
    "Approval requests and decisions across every workspace: waits, who decided (person, AI reviewer, rule, mode, bot), what is pending now and what expired. Read from the obs model (ADR-0046).",
  from: "now-24h",
  variables: [],
  sections: [
    {
      title: "Overview",
      panels: [
        {
          title: "Requested",
          description: "Approval requests created in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () => `SELECT count(*) AS requested FROM approval_requests_named WHERE ${requested}`,
        },
        {
          title: "Pending now",
          description:
            "Requests waiting for a decision now, whenever they were made, whose run is still open.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            "SELECT count(*) AS pending FROM approval_requests_named WHERE state = 'pending'",
        },
        {
          title: "Decided",
          description: "Approvals decided in the time range, by anyone or anything.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () => `SELECT count(*) AS decided FROM approval_waits WHERE ${decided}`,
        },
        {
          title: "Expired",
          description: "Approvals nobody answered within the workspace's expiry window.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "short",
          sql: () =>
            `SELECT count(*) AS expired FROM approval_waits WHERE decider_group = 'expired' AND ${decided}`,
        },
        {
          title: "Decided by a person",
          description: "Decisions made by a person, as a share of all decisions in the time range.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "percent",
          sql: () =>
            `SELECT 100.0 * sum(CASE WHEN decider_group = 'human' THEN 1 ELSE 0 END) / nullif(count(*), 0) AS human_share FROM approval_waits WHERE ${decided}`,
        },
        {
          title: "Median wait for a person",
          description: "Median time from the request to a person's decision.",
          kind: "stat",
          w: 4,
          h: 4,
          unit: "ms",
          sql: (d) =>
            `SELECT median AS median_wait_ms FROM (${d.median({
              from: `SELECT wait_ms FROM approval_waits WHERE ${human}`,
              value: "wait_ms",
            })}) m`,
        },
      ],
    },
    {
      title: "Over time",
      panels: [
        {
          title: "Decisions per hour by who decided",
          description:
            "Decisions per hour, stacked by person, reviewer, rule, mode, bot, expired, and closed with the run.",
          kind: "timeseries",
          style: "stacked-bars",
          w: 12,
          h: 8,
          unit: "short",
          sql: (d) =>
            `SELECT ${d.hourBucket("decided_at")} AS time, coalesce(decider_group, 'other') AS decider_group, count(*) AS approvals FROM approval_waits WHERE ${decided} GROUP BY 1, 2 ORDER BY 1, 2`,
        },
        {
          title: "Wait for a person per hour (p50, p95)",
          description: "Percentiles of the wait of the decisions people made in each hour.",
          kind: "timeseries",
          style: "lines",
          w: 12,
          h: 8,
          unit: "ms",
          sql: (d) =>
            `SELECT time, p50, p95 FROM (${percentiles({
              from: `SELECT ${d.hourBucket("decided_at")} AS time, wait_ms FROM approval_waits WHERE ${human}`,
              value: "wait_ms",
              by: ["time"],
              ps: [50, 95],
            })}) q ORDER BY time`,
        },
      ],
    },
    {
      title: "Pending and expired",
      panels: [
        {
          title: "Pending now",
          description:
            "Every request waiting for a decision, oldest first, with how long it has waited. A run id opens the run view.",
          kind: "table",
          w: 24,
          h: 9,
          unit: "short",
          columnUnits: { age_ms: "ms" },
          runLinks: ["run_id"],
          sql: (d) =>
            `SELECT created_at, workspace_name, bot_name, kind, tool_name, risk_level, wait_mode, ${d.timeDiffMs(NOW, "created_at")} AS age_ms, run_status, run_id FROM approval_requests_named WHERE state = 'pending' AND created_at IS NOT NULL ORDER BY created_at, approval_id LIMIT 100`,
        },
        {
          title: "Expired",
          description: "The newest approvals that expired unanswered. A run id opens the run view.",
          kind: "table",
          w: 24,
          h: 8,
          unit: "short",
          columnUnits: { wait_ms: "ms" },
          runLinks: ["run_id"],
          sql: () =>
            `SELECT decided_at, workspace_name, bot_name, kind, tool_name, risk_level, wait_mode, wait_ms, run_id FROM approval_waits WHERE decider_group = 'expired' AND decided_at IS NOT NULL AND ${decided} ORDER BY decided_at DESC LIMIT 50`,
        },
      ],
    },
    {
      title: "Per workspace and kind",
      panels: [
        {
          title: "Workspaces",
          description:
            "Per workspace, the requests made in the time range by how they ended, and the median and p95 wait for a person.",
          kind: "table",
          w: 24,
          h: 9,
          unit: "short",
          columnUnits: { human_wait_p50_ms: "ms", human_wait_p95_ms: "ms" },
          sql: () =>
            `SELECT w.workspace, ${[
              "requested",
              "decided",
              "by_human",
              "by_reviewer",
              "by_rule",
              "by_mode",
              "by_bot",
              "expired",
              "closed_with_run",
              "denied",
              "pending",
            ]
              .map((c) => `w.${c}`)
              .join(
                ", ",
              )}, q.p50 AS human_wait_p50_ms, q.p95 AS human_wait_p95_ms FROM (SELECT coalesce(workspace_id, '') AS workspace_key, max(coalesce(workspace_name, workspace_id)) AS workspace, ${BY_OUTCOME} FROM approval_requests_named WHERE ${requested} GROUP BY 1) w LEFT JOIN (${percentiles(
              {
                from: `SELECT coalesce(workspace_id, '') AS workspace_key, wait_ms FROM approval_requests_named WHERE decider_group = 'human' AND ${requested}`,
                value: "wait_ms",
                by: ["workspace_key"],
                ps: [50, 95],
              },
            )}) q ON q.workspace_key = w.workspace_key ORDER BY w.requested DESC, w.workspace`,
        },
        {
          title: "By kind and decision",
          description:
            "Decisions grouped by kind, risk level, who decided and decision, with the median and longest wait.",
          kind: "table",
          w: 12,
          h: 9,
          unit: "short",
          columnUnits: { median_wait_ms: "ms", max_wait_ms: "ms" },
          sql: (d) =>
            `SELECT a.kind, a.risk_level, a.decider_group, a.decision, a.approvals, m.median AS median_wait_ms, a.max_wait_ms FROM (SELECT ${APPROVAL_KEYS}, count(*) AS approvals, max(wait_ms) AS max_wait_ms FROM approval_waits WHERE ${decided} GROUP BY 1, 2, 3, 4) a LEFT JOIN (${d.median(
              {
                from: `SELECT ${APPROVAL_KEYS}, wait_ms FROM approval_waits WHERE ${decided}`,
                value: "wait_ms",
                by: ["kind", "risk_level", "decider_group", "decision"],
              },
            )}) m ON m.kind = a.kind AND m.risk_level = a.risk_level AND m.decider_group = a.decider_group AND m.decision = a.decision ORDER BY a.approvals DESC, a.kind, a.decision`,
        },
        {
          title: "Longest waits",
          description: "The decisions that waited longest. A run id opens the run view.",
          kind: "table",
          w: 12,
          h: 9,
          unit: "short",
          columnUnits: { wait_ms: "ms" },
          runLinks: ["run_id"],
          sql: () =>
            `SELECT decided_at, workspace_name, bot_name, kind, tool_name, decider_group, decision, decided_by, wait_ms, run_id FROM approval_waits WHERE wait_ms IS NOT NULL AND ${decided} ORDER BY wait_ms DESC, decided_at DESC LIMIT 50`,
        },
      ],
    },
  ],
};
