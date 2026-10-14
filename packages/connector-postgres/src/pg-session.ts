// The production SqlSessionFactory: one `pg` Client per case, autocommit (no BEGIN is ever sent),
// the simple query protocol, `statement_timeout` set at connect time, every value kept as text.

import pg from "pg";
import type { SqlSession, SqlSessionFactory } from "./sql-session.js";

const CONNECT_TIMEOUT_MS = 5_000;

/** Every type is returned as the server's text; the receipt never reinterprets a value. */
const TEXT_TYPES = { getTypeParser: () => (value: string) => value };

export function pgSessionFactory(databaseUrl: string): SqlSessionFactory {
  return async ({ statementTimeoutMs }) => {
    const client = new pg.Client({
      connectionString: databaseUrl,
      statement_timeout: statementTimeoutMs,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      application_name: "deskmates-connector-postgres",
      types: TEXT_TYPES,
    });
    // An idle connection dropped by the server emits `error`; without a listener it would crash
    // the process. The next query on it rejects and is recorded as a connection loss.
    client.on("error", () => {});
    await client.connect();
    const session: SqlSession = {
      async query(sql) {
        const res = await client.query<(string | null)[]>({ text: sql, rowMode: "array" });
        return {
          command: res.command ?? null,
          rowCount: res.rowCount ?? null,
          columns: (res.fields ?? []).map((f) => ({ name: f.name, typeOid: f.dataTypeID })),
          rows: res.rows ?? [],
        };
      },
      async close() {
        await client.end().catch(() => {});
      },
      destroy() {
        client.connection.stream.destroy();
        void client.end().catch(() => {});
      },
    };
    return session;
  };
}
