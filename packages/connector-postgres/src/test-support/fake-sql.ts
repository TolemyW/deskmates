// A scripted SqlSessionFactory for T0/T1 tests: each statement is answered by a handler that
// returns rows, throws an error with a SQLSTATE, throws a connection loss, or never answers.
// It records every statement run and every session opened, closed or destroyed. Test-only.

import type {
  SqlQueryResult,
  SqlSession,
  SqlSessionFactory,
  SqlSessionOptions,
} from "../sql-session.js";

export class FakeSqlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** What a handler may answer: a result, an error to throw, or `"hang"` to never settle. */
export type FakeAnswer = SqlQueryResult | FakeSqlError | "hang";

export type FakeHandler = (sql: string) => FakeAnswer;

export const rowsOf = (rows: (string | null)[][], names = ["?column?"]): SqlQueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  columns: names.map((name) => ({ name, typeOid: 25 })),
  rows,
});

export const commandOf = (command: string, rowCount = 0): SqlQueryResult => ({
  command,
  rowCount,
  columns: [],
  rows: [],
});

export interface FakeSessionLog {
  id: number;
  options: SqlSessionOptions;
  statements: string[];
  closed: boolean;
  destroyed: boolean;
}

export class FakeSql {
  readonly sessions: FakeSessionLog[] = [];
  /** Every statement any session ran, in order. */
  readonly executed: string[] = [];
  /** When set, the next `connect` fails with this error (once). */
  failNextConnect: FakeSqlError | undefined;

  constructor(public handler: FakeHandler = () => commandOf("SELECT")) {}

  readonly factory: SqlSessionFactory = async (options) => {
    if (this.failNextConnect) {
      const err = this.failNextConnect;
      this.failNextConnect = undefined;
      throw err;
    }
    const log: FakeSessionLog = {
      id: this.sessions.length + 1,
      options,
      statements: [],
      closed: false,
      destroyed: false,
    };
    this.sessions.push(log);
    const session: SqlSession = {
      query: (sql) => {
        if (log.closed || log.destroyed)
          return Promise.reject(new FakeSqlError("Client was closed and is not queryable"));
        log.statements.push(sql);
        this.executed.push(sql);
        const answer = this.handler(sql);
        if (answer === "hang") return new Promise<SqlQueryResult>(() => {});
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer);
      },
      close: async () => {
        log.closed = true;
      },
      destroy: () => {
        log.destroyed = true;
      },
    };
    return session;
  };
}
