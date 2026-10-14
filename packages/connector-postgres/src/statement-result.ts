// What a receipt records per statement and per case.
//
// `ok`: the statement completed. `error`: the server rejected it with a definite error; nothing
// of it took effect. `uncertain`: a timeout or connection loss; whether it took effect is unknown
// and it is never retried. `not_run`: the statement was never sent (its case lost its connection
// earlier, or the connector stopped).

export type StatementOutcome = "ok" | "error" | "uncertain" | "not_run";

export interface StatementError {
  /** The server's SQLSTATE; null when the failure was not an answer from the server. */
  sqlstate: string | null;
  message: string;
}

export interface StatementResult {
  index: number;
  sql: string;
  ok: boolean;
  outcome: StatementOutcome;
  command?: string | null;
  rowCount?: number | null;
  columns?: { name: string; typeOid: number }[];
  /** At most `resultRowsPerStatement` rows, values as the server's text. */
  rows?: (string | null)[][];
  truncated?: boolean;
  error?: StatementError;
  durationMs: number;
}

export interface CaseResult {
  caseId: string;
  statements: StatementResult[];
  /** Set when the case's connection could not be opened; every statement is then `not_run`. */
  connectError?: StatementError;
}

/** A batch succeeded when every statement reached a definite outcome (`ok` or `error`). */
export function batchSucceeded(cases: CaseResult[]): boolean {
  return cases.every(
    (c) =>
      c.connectError === undefined &&
      c.statements.every((s) => s.outcome === "ok" || s.outcome === "error"),
  );
}

export function outcomeCounts(cases: CaseResult[]): Record<StatementOutcome, number> {
  const counts: Record<StatementOutcome, number> = { ok: 0, error: 0, uncertain: 0, not_run: 0 };
  for (const c of cases) for (const s of c.statements) counts[s.outcome] += 1;
  return counts;
}
