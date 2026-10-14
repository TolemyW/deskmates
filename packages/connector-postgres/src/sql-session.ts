// The database seam. Execution talks to a `SqlSession`, one connection per case; production opens
// them with `pg` (pg-session.ts), tests inject a scripted fake. Values arrive as PostgreSQL's text
// output, never parsed into JavaScript numbers or dates, so what a receipt shows is what the
// server sent.

export interface SqlColumn {
  name: string;
  typeOid: number;
}

export interface SqlQueryResult {
  /** The command tag's verb (`SELECT`, `INSERT`, `CREATE`), when the server sent one. */
  command: string | null;
  rowCount: number | null;
  columns: SqlColumn[];
  rows: (string | null)[][];
}

export interface SqlSession {
  /** Runs one statement. Rejects with an error carrying `code` (the SQLSTATE) when the server sent one. */
  query(sql: string): Promise<SqlQueryResult>;
  /** Ends the connection politely. */
  close(): Promise<void>;
  /** Drops the connection at once; used when a statement outlives its client-side deadline. */
  destroy(): void;
}

export interface SqlSessionOptions {
  /** Applied as the connection's `statement_timeout`. */
  statementTimeoutMs: number;
}

export type SqlSessionFactory = (opts: SqlSessionOptions) => Promise<SqlSession>;
