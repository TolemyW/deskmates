// Executes one validated batch: cases in order, each on its own connection, its statements in
// order in autocommit mode. The discipline is the host adapter's (sql_worker.py): a statement's
// outcome is recorded as soon as it is known, a server error does not stop the case, and a
// statement whose effect is unknown (timeout, connection loss) is marked `uncertain` and never
// sent again. A connection loss ends its case; the next case gets a fresh connection.

import type { ConnectorLimits } from "./config.js";
import type { SqlSession, SqlSessionFactory } from "./sql-session.js";
import type { CaseResult, StatementError, StatementResult } from "./statement-result.js";
import type { SqlBatch } from "./submission.js";

/** How long past `statement_timeout` the client waits before it drops the connection itself. */
export const CLIENT_GRACE_MS = 5_000;

const QUERY_CANCELED = "57014";
const CONNECTION_LOST_STATES = new Set(["57P01", "57P02", "57P03"]);

export interface ExecuteDeps {
  sessions: SqlSessionFactory;
  limits: Pick<ConnectorLimits, "resultRowsPerStatement" | "statementTimeoutMs">;
  /** Called after every statement outcome is known, before the next statement is sent. */
  onStatement?: (caseIndex: number, result: StatementResult) => void;
  /** Called when a case's connection could not be opened. */
  onConnectError?: (caseIndex: number, error: StatementError) => void;
  /** Strings that must never appear in a recorded message (the DSN, its password). */
  secrets?: string[];
  graceMs?: number;
  now?: () => number;
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s !== "") out = out.split(s).join("[redacted]");
  return out;
}

export function errorOf(err: unknown, secrets: string[] = []): StatementError {
  const message = err instanceof Error ? err.message : String(err);
  return { sqlstate: sqlstateOf(err), message: redact(message, secrets) };
}

function isConnectionLoss(sqlstate: string | null): boolean {
  return sqlstate === null || sqlstate.startsWith("08") || CONNECTION_LOST_STATES.has(sqlstate);
}

class ClientDeadline extends Error {}

const notRun = (index: number, sql: string): StatementResult => ({
  index,
  sql,
  ok: false,
  outcome: "not_run",
  durationMs: 0,
});

export async function executeBatch(batch: SqlBatch, deps: ExecuteDeps): Promise<CaseResult[]> {
  const now = deps.now ?? (() => performance.now());
  const secrets = deps.secrets ?? [];
  const deadlineMs = deps.limits.statementTimeoutMs + (deps.graceMs ?? CLIENT_GRACE_MS);
  const results: CaseResult[] = [];

  for (const [caseIndex, sqlCase] of batch.cases.entries()) {
    const caseResult: CaseResult = { caseId: sqlCase.id, statements: [] };
    results.push(caseResult);
    let session: SqlSession;
    try {
      session = await deps.sessions({ statementTimeoutMs: deps.limits.statementTimeoutMs });
    } catch (err) {
      caseResult.connectError = errorOf(err, secrets);
      deps.onConnectError?.(caseIndex, caseResult.connectError);
      caseResult.statements = sqlCase.steps.map((sql, i) => notRun(i, sql));
      continue;
    }
    let lost = false;
    for (const [index, sql] of sqlCase.steps.entries()) {
      if (lost) {
        const skipped = notRun(index, sql);
        caseResult.statements.push(skipped);
        deps.onStatement?.(caseIndex, skipped);
        continue;
      }
      const started = now();
      let timer: NodeJS.Timeout | undefined;
      let result: StatementResult;
      try {
        const res = await Promise.race([
          session.query(sql),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ClientDeadline()), deadlineMs);
          }),
        ]);
        const cap = deps.limits.resultRowsPerStatement;
        result = {
          index,
          sql,
          ok: true,
          outcome: "ok",
          command: res.command,
          rowCount: res.rowCount,
          columns: res.columns,
          rows: res.rows.slice(0, cap),
          truncated: res.rows.length > cap,
          durationMs: Math.round(now() - started),
        };
      } catch (err) {
        const durationMs = Math.round(now() - started);
        if (err instanceof ClientDeadline) {
          session.destroy();
          lost = true;
          result = {
            index,
            sql,
            ok: false,
            outcome: "uncertain",
            error: {
              sqlstate: null,
              message: `no answer within the client deadline of ${deadlineMs} ms; the connection was dropped and the statement's effect is unknown`,
            },
            durationMs,
          };
        } else {
          const error = errorOf(err, secrets);
          const connectionLost = isConnectionLoss(error.sqlstate);
          if (connectionLost) {
            session.destroy();
            lost = true;
          }
          const uncertain = connectionLost || error.sqlstate === QUERY_CANCELED;
          result = {
            index,
            sql,
            ok: false,
            outcome: uncertain ? "uncertain" : "error",
            error,
            durationMs,
          };
        }
      } finally {
        clearTimeout(timer);
      }
      caseResult.statements.push(result);
      deps.onStatement?.(caseIndex, result);
    }
    if (!lost) await session.close();
  }
  return results;
}
