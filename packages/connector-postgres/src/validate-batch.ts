// The dry check behind POST /validate. It never touches the database: the shape comes from the
// capabilities schema, the limits from configuration, and each step's kind and effect from the
// statement classifier. Every error names the field or step it is about, so a bot can fix exactly
// that step and validate again.

import {
  type ConnectorEffect,
  type ConnectorFieldError,
  validateAgainstSchema,
} from "@deskmates/contracts";
import { classifyStatement } from "./classify-statement.js";
import type { ConnectorLimits } from "./config.js";
import { SUBMISSION_SCHEMA, type SqlBatch } from "./submission.js";

export interface BatchValidation {
  valid: boolean;
  effect: ConnectorEffect;
  summary: string;
  errors: ConnectorFieldError[];
  statementCount: number;
  /** The batch, present only when `valid`: what submit executes. */
  batch?: SqlBatch;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function validateBatch(submission: unknown, limits: ConnectorLimits): BatchValidation {
  const errors = validateAgainstSchema(SUBMISSION_SCHEMA, submission);
  const record =
    typeof submission === "object" && submission !== null && !Array.isArray(submission)
      ? (submission as Record<string, unknown>)
      : undefined;
  if (!record || !Array.isArray(record.cases)) {
    return {
      valid: false,
      effect: "external",
      summary: `not a batch: ${plural(errors.length, "error")}`,
      errors,
      statementCount: 0,
    };
  }
  const batchId = typeof record.batch_id === "string" ? record.batch_id : "";
  if (typeof record.batch_id === "string" && batchId.trim() === "")
    errors.push({ path: "batch_id", code: "invalid", message: "batch_id must not be empty" });

  const cases = record.cases as unknown[];
  if (cases.length === 0)
    errors.push({ path: "cases", code: "invalid", message: "a batch holds at least one case" });
  if (cases.length > limits.casesPerBatch)
    errors.push({
      path: "cases",
      code: "invalid",
      message: `a batch holds at most ${limits.casesPerBatch} cases; this one holds ${cases.length}`,
    });

  const kinds = new Map<string, number>();
  const seenIds = new Set<string>();
  let statementCount = 0;
  let allRead = true;
  cases.forEach((c, i) => {
    if (typeof c !== "object" || c === null || Array.isArray(c)) return;
    const item = c as Record<string, unknown>;
    if (typeof item.id === "string") {
      if (item.id.trim() === "")
        errors.push({
          path: `cases[${i}].id`,
          code: "invalid",
          message: "a case id must not be empty",
        });
      else if (seenIds.has(item.id))
        errors.push({
          path: `cases[${i}].id`,
          code: "invalid",
          message: `case id ${JSON.stringify(item.id)} is already used in this batch`,
        });
      seenIds.add(item.id);
    }
    if (!Array.isArray(item.steps)) return;
    const steps = item.steps as unknown[];
    statementCount += steps.length;
    if (steps.length === 0)
      errors.push({
        path: `cases[${i}].steps`,
        code: "invalid",
        message: "a case holds at least one step",
      });
    if (steps.length > limits.statementsPerCase)
      errors.push({
        path: `cases[${i}].steps`,
        code: "invalid",
        message: `a case holds at most ${limits.statementsPerCase} steps; this one holds ${steps.length}`,
      });
    steps.forEach((sql, j) => {
      if (typeof sql !== "string") return;
      const path = `cases[${i}].steps[${j}]`;
      const bytes = Buffer.byteLength(sql, "utf8");
      if (bytes > limits.statementBytes) {
        errors.push({
          path,
          code: "invalid",
          message: `a step is at most ${limits.statementBytes} bytes; this one is ${bytes}`,
        });
        allRead = false;
        return;
      }
      const c = classifyStatement(sql);
      if (!c.ok) {
        errors.push({ path, code: c.code, message: c.message });
        allRead = false;
        return;
      }
      kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
      if (c.effect !== "read") allRead = false;
    });
  });
  if (statementCount > limits.statementsPerBatch)
    errors.push({
      path: "cases",
      code: "invalid",
      message: `a batch holds at most ${limits.statementsPerBatch} statements; this one holds ${statementCount} statements`,
    });

  const valid = errors.length === 0;
  const effect: ConnectorEffect = allRead && statementCount > 0 ? "read" : "external";
  const kindList = [...kinds.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  const head = `batch ${batchId || "(unnamed)"}: ${plural(cases.length, "case")}`;
  const kindsPart = kindList ? ` (${kindList})` : "";
  const errorPart = valid ? "" : `; ${plural(errors.length, "error")}, not submittable`;
  const summary = `${head}, ${plural(statementCount, "statement")}, effect ${effect}${kindsPart}${errorPart}`;
  return {
    valid,
    effect,
    summary,
    errors,
    statementCount,
    ...(valid ? { batch: submission as SqlBatch } : {}),
  };
}
