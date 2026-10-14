// The capabilities document POST /describe returns (ADR-0012 item 1). There is one operation,
// `sql_batch`; it advertises `external`, the most a batch can be, because the effect of one
// submission is decided by its validation: `read` when every statement reads, else `external`.

import type { ConnectorCapabilities } from "@deskmates/contracts";
import type { ConnectorLimits } from "./config.js";
import { SUBMISSION_SCHEMA } from "./submission.js";

/** Kept equal to package.json's version by a test. */
export const CONNECTOR_VERSION = "0.1.0";

export const UNSUPPORTED: readonly string[] = [
  "procedures and anonymous code blocks: CREATE PROCEDURE, CALL, DO",
  "transaction control: BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK, ABORT, SAVEPOINT, RELEASE, PREPARE TRANSACTION; every step runs in its own autocommit transaction",
  "extensions: CREATE, ALTER and DROP EXTENSION",
  "COPY in any direction",
  "changing statement_timeout (SET, RESET or set_config); the connector sets it per statement",
  "more than one statement in a step",
  "statements the pgsql-ast-parser grammar does not parse (for example CREATE TABLE AS, SELECT INTO, IS UNKNOWN); they are rejected at validation, not guessed at",
  "retrying a statement: a timed-out or connection-lost statement is recorded as uncertain and never run again",
];

export function capabilities(name: string, limits: ConnectorLimits): ConnectorCapabilities {
  return {
    name,
    version: CONNECTOR_VERSION,
    operations: [
      {
        name: "sql_batch",
        effect: "external",
        description:
          "Runs a batch of cases on one PostgreSQL-protocol database, each case on its own connection, its steps in order in autocommit mode. The effect of a submission comes from its validation: read when every statement is SELECT, WITH ... SELECT, EXPLAIN (without ANALYZE of a write) or SHOW, else external. A failed step does not stop the case unless the connection is lost; the receipt carries every step's rows (capped) or SQLSTATE and message.",
      },
    ],
    limits: { ...limits },
    submissionSchema: SUBMISSION_SCHEMA,
    unsupported: [...UNSUPPORTED],
  };
}
