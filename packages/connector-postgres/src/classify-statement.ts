// Classifies one SQL step without touching the database. A step is exactly one statement; its
// effect is `read` when it is a SELECT (including UNION and VALUES), a WITH whose every part is a
// read, an EXPLAIN without ANALYZE, an EXPLAIN ANALYZE of a read, or SHOW; anything else the
// parser understands is `external`. Statement kinds this connector does not run are rejected
// before parsing: procedures (CREATE PROCEDURE, CALL, DO), transaction control (each step runs in
// its own autocommit transaction), extensions, COPY, and changing the statement timeout the
// connector owns.
//
// The parser is pgsql-ast-parser (pure JS). Its PostgreSQL coverage is incomplete, so a statement
// it cannot parse is rejected as `invalid` with the parser's message rather than guessed at.
// `read` is a static classification: a user-defined function called from a SELECT can still write,
// and only the known side-effecting built-ins below turn a SELECT into `external`.

import { parse } from "pgsql-ast-parser";

export type StatementEffect = "read" | "external";

export type StatementClassification =
  | { ok: true; kind: string; effect: StatementEffect }
  | { ok: false; code: "unsupported" | "invalid"; message: string };

interface UnsupportedRule {
  pattern: RegExp;
  message: string;
}

const UNSUPPORTED: readonly UnsupportedRule[] = [
  {
    pattern:
      /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS)\b/,
    message:
      "transaction control statements are not supported: every step runs in its own autocommit transaction",
  },
  {
    pattern: /^(CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE|ALTER\s+PROCEDURE|DROP\s+PROCEDURE|CALL|DO)\b/,
    message: "procedures and anonymous code blocks (CREATE PROCEDURE, CALL, DO) are not supported",
  },
  {
    pattern: /^(CREATE|ALTER|DROP)\s+EXTENSION\b/,
    message: "extensions are not supported",
  },
  { pattern: /^COPY\b/, message: "COPY is not supported" },
  {
    pattern: /^(SET\s+(SESSION\s+|LOCAL\s+)?|RESET\s+)STATEMENT_TIMEOUT\b/,
    message: "the statement timeout is set by the connector and cannot be changed by a step",
  },
];

/** Settings a step may not change through `set_config`, for the same reason as SET. */
const OWNED_SETTINGS = new Set(["statement_timeout"]);

/** Built-ins that change state even when called from a SELECT. */
const SIDE_EFFECT_FUNCTIONS = new Set([
  "nextval",
  "setval",
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_notify",
  "pg_create_logical_replication_slot",
  "pg_create_physical_replication_slot",
  "pg_drop_replication_slot",
]);
const SIDE_EFFECT_PREFIXES = ["pg_advisory", "pg_try_advisory", "lo_", "dblink", "pg_stat_reset"];

const READ_TYPES = new Set(["select", "union", "union all", "values", "show"]);
const WITH_TYPES = new Set(["with", "with recursive"]);
const WRITE_NODE_TYPES = new Set(["insert", "update", "delete"]);

/** Removes leading whitespace, `--` and non-nested `/* *\/` comments, and stray semicolons. */
function stripLeading(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^[\s;]+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    }
    if (s === before) return s;
  }
}

function kindOf(type: string): string {
  if (READ_TYPES.has(type) && type !== "show") return "SELECT";
  if (WITH_TYPES.has(type)) return "WITH";
  return type.toUpperCase();
}

function isSideEffectFunction(name: string): boolean {
  return (
    SIDE_EFFECT_FUNCTIONS.has(name) ||
    SIDE_EFFECT_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

interface Scan {
  writes: boolean;
  sideEffects: boolean;
  ownedSetting?: string;
}

/** Walks the whole AST: nested data-modifying statements and function calls anywhere count. */
function scan(node: unknown, out: Scan): void {
  if (Array.isArray(node)) {
    for (const item of node) scan(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  const type = record.type;
  if (typeof type === "string") {
    if (WRITE_NODE_TYPES.has(type)) out.writes = true;
    if (type === "call") {
      const fn = record.function as { name?: unknown } | undefined;
      const name = typeof fn?.name === "string" ? fn.name.toLowerCase() : "";
      if (isSideEffectFunction(name)) out.sideEffects = true;
      if (name === "set_config") {
        const first = (record.args as { type?: unknown; value?: unknown }[] | undefined)?.[0];
        const setting = typeof first?.value === "string" ? first.value.toLowerCase() : "";
        if (OWNED_SETTINGS.has(setting)) out.ownedSetting = setting;
      }
    }
  }
  for (const value of Object.values(record)) scan(value, out);
}

interface ExplainPrefix {
  analyze: boolean;
  rest: string;
}

/** Splits `EXPLAIN [ANALYZE] [VERBOSE] [( options )]` off the statement it explains. */
function explainPrefix(stripped: string): ExplainPrefix | undefined {
  const head = /^EXPLAIN\b/i.exec(stripped);
  if (!head) return undefined;
  let rest = stripped.slice(head[0].length);
  let analyze = false;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    const word = /^(ANALYZE|ANALYSE|VERBOSE)\b/i.exec(rest);
    if (word) {
      if (/^ANALY[SZ]E$/i.test(word[1] ?? "")) analyze = true;
      rest = rest.slice(word[0].length);
      continue;
    }
    if (rest.startsWith("(")) {
      const close = rest.indexOf(")");
      if (close === -1) return { analyze, rest: "" };
      // Any mention of ANALYZE counts, even `ANALYZE false`: the classification stays conservative.
      if (/\bANALY[SZ]E\b/i.test(rest.slice(1, close))) analyze = true;
      rest = rest.slice(close + 1);
      continue;
    }
    return { analyze, rest };
  }
}

function parseError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split("\n")[0] ?? "").trim() || "the statement could not be parsed";
}

export function classifyStatement(sql: string): StatementClassification {
  const stripped = stripLeading(sql);
  if (stripped === "")
    return { ok: false, code: "invalid", message: "the step holds no statement" };
  const head = stripped.toUpperCase();
  for (const rule of UNSUPPORTED) {
    if (rule.pattern.test(head)) return { ok: false, code: "unsupported", message: rule.message };
  }
  const explain = explainPrefix(stripped);
  if (explain) {
    const inner = classifyStatement(explain.rest);
    if (!inner.ok) return inner;
    return { ok: true, kind: "EXPLAIN", effect: explain.analyze ? inner.effect : "read" };
  }
  let statements: unknown[];
  try {
    statements = parse(stripped);
  } catch (err) {
    return {
      ok: false,
      code: "invalid",
      message: `not parsed (${parseError(err)}); this connector accepts what pgsql-ast-parser parses`,
    };
  }
  if (statements.length !== 1)
    return {
      ok: false,
      code: "invalid",
      message: `a step holds exactly one statement; this one holds ${statements.length}`,
    };
  const statement = statements[0] as { type: string };
  const found: Scan = { writes: false, sideEffects: false };
  scan(statement, found);
  if (found.ownedSetting !== undefined)
    return {
      ok: false,
      code: "unsupported",
      message: `${found.ownedSetting} is set by the connector and cannot be changed by a step`,
    };
  const kind = kindOf(statement.type);
  const readShape = READ_TYPES.has(statement.type) || WITH_TYPES.has(statement.type);
  const effect: StatementEffect =
    readShape && !found.writes && !found.sideEffects ? "read" : "external";
  return { ok: true, kind, effect };
}
