// The failure class of a run (issue #11, ADR-0042 decision 1): a classification of `runs.error`
// text, so an operator sees "88 of 106 failures were one dead model" without exporting the
// ledger. One ordered rule table is the only source: `classifyFailure` applies it in code and
// `failureClassSql` renders the same rules as one SQL CASE, so the run list can filter and page
// by class in SQL and the two cannot drift (`failure-class.test.ts` checks both on the corpus).
//
// A rule matches when the lower-cased error contains every `all` substring and at least one
// `any` substring. Rules are tried in order and the first match wins, so a root cause (a model
// that is not there) is named before its symptom (the deadline that ran out waiting for it).
// Substrings are matched literally; nothing here is a regular expression, which SQLite lacks.

import {
  RUN_ERROR_BUDGET,
  RUN_ERROR_DEADLINE,
  RUN_ERROR_NO_REPLY,
  RUN_ERROR_TURN_BUDGET,
  type RunFailureClass,
} from "@deskmates/contracts";

interface FailureRule {
  failureClass: Exclude<RunFailureClass, "other">;
  /** Exact (trimmed, lower-cased) error values; matched before any substring rule. */
  exact?: readonly string[];
  any?: readonly string[];
  all?: readonly string[];
}

/** Ordered: the first rule that matches decides. Every substring is lower case. */
export const FAILURE_RULES: readonly FailureRule[] = [
  // The Gateway's own reasons are exact codes (contracts `RUN_ERROR_*`).
  { failureClass: "no_reply", exact: [RUN_ERROR_NO_REPLY] },
  { failureClass: "wall_clock", exact: [RUN_ERROR_DEADLINE] },
  { failureClass: "budget_limit", exact: [RUN_ERROR_TURN_BUDGET, RUN_ERROR_BUDGET] },
  // The sidecar rejected its start request: since v0.6.9 that has been a tool name it did not
  // know (exit 2 with the zod issue list on stderr).
  {
    failureClass: "tool_allowlist",
    any: [
      "invalid startrunrequest",
      "not in the allowed tools",
      "tool is not allowed",
      "tool not allowed",
      "is not an allowed tool",
    ],
  },
  // The model is not there: named before the deadline that ran out waiting for it, and before
  // the server error an upstream wraps "no worker available" in.
  {
    failureClass: "model_unavailable",
    any: [
      "model_not_found",
      "not_found_error",
      "no worker available",
      "model not found",
      "model_not_selected",
      "pricing_missing",
      "does not exist or you do not have access",
      "unknown model",
      "invalid model",
      "no available channel",
      "is not configured",
    ],
  },
  {
    failureClass: "egress_blocked",
    any: [
      "egress_blocked",
      "egress_ask",
      "not in the workspace allowlist",
      "denied by the live egress allowlist",
    ],
  },
  {
    failureClass: "approval_denied",
    any: [
      "approval_denied",
      "approval denied",
      "denied by human",
      "denied by the human",
      "denied by rule",
      "denied by the reviewer",
      "the human denied",
      "decision: deny",
    ],
  },
  // Retry exhaustion on a server error: the upstream is down, whatever the job. A job deadline
  // that ran out while the SDK retried a 5xx (`modelJobDeadlineError`) names the same cause.
  {
    failureClass: "model_unavailable",
    any: [
      "api error: 500",
      "api error: 502",
      "api error: 503",
      "api error: 529",
      "last on http 500",
      "last on http 502",
      "last on http 503",
      "last on http 529",
      "internal server error",
      "overloaded_error",
      "service unavailable",
      "bad gateway",
      "retries exhausted",
      "max retries",
      "maximum retries",
    ],
  },
  // A model job's deadline (`modelJobDeadlineError`) or a request timeout with no cause above.
  {
    failureClass: "model_deadline",
    any: [
      "model job did not finish within",
      "request timed out",
      "api_timeout",
      "timed out waiting for the model",
    ],
  },
  {
    failureClass: "wall_clock",
    any: ["exceeded run_timeout_seconds", "reached the run deadline", "wall-clock", "wall clock"],
  },
  {
    failureClass: "sdk_abort",
    any: ["process aborted by user", "aborterror", "operation was aborted", "aborted by user"],
  },
];

/** The class of one run error; `undefined` for a run with no error. */
export function classifyFailure(error: string | null | undefined): RunFailureClass | undefined {
  if (error === null || error === undefined) return undefined;
  const text = error.toLowerCase();
  const trimmed = text.trim();
  for (const rule of FAILURE_RULES) {
    if (rule.exact) {
      if (rule.exact.includes(trimmed)) return rule.failureClass;
      continue;
    }
    const all = rule.all ?? [];
    const any = rule.any ?? [];
    if (
      all.every((s) => text.includes(s)) &&
      (any.length === 0 || any.some((s) => text.includes(s)))
    )
      return rule.failureClass;
  }
  return "other";
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * The same classification as one SQL expression over `column` (for example `r.error`): NULL for
 * a NULL error, else the class. `lower()` and `instr()` give the substring test `classifyFailure`
 * uses; SQLite's `lower` folds ASCII only, and every rule substring is ASCII.
 */
export function failureClassSql(column: string): string {
  const text = `lower(${column})`;
  const branches = FAILURE_RULES.map((rule) => {
    if (rule.exact) {
      return `WHEN trim(${text}) IN (${rule.exact.map(literal).join(", ")}) THEN ${literal(rule.failureClass)}`;
    }
    const conditions = [
      ...(rule.all ?? []).map((s) => `instr(${text}, ${literal(s)}) > 0`),
      ...((rule.any ?? []).length > 0
        ? [`(${(rule.any ?? []).map((s) => `instr(${text}, ${literal(s)}) > 0`).join(" OR ")})`]
        : []),
    ];
    return `WHEN ${conditions.join(" AND ")} THEN ${literal(rule.failureClass)}`;
  });
  return `(CASE WHEN ${column} IS NULL THEN NULL ${branches.join(" ")} ELSE 'other' END)`;
}
