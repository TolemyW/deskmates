// Service configuration, read from the environment. The DSN and the token are secrets: an error
// about either names the variable, never its value, and neither is ever logged.

/** Limits advertised in the capabilities document and enforced by validate and submit. */
export interface ConnectorLimits {
  casesPerBatch: number;
  statementsPerCase: number;
  statementsPerBatch: number;
  resultRowsPerStatement: number;
  statementTimeoutMs: number;
  statementBytes: number;
  validationTtlSeconds: number;
}

/**
 * Defaults follow the temporary host adapter of the VendorDB campaigns
 * (the campaign submission contract: three cases, ten statements per case,
 * twenty per batch, 200 result rows, a ten-second statement deadline) and ADR-0012's 900-second
 * validation TTL. All are guesses until a live campaign through this connector calibrates them.
 */
export const DEFAULT_LIMITS: Readonly<ConnectorLimits> = {
  casesPerBatch: 3,
  statementsPerCase: 10,
  statementsPerBatch: 20,
  resultRowsPerStatement: 200,
  statementTimeoutMs: 10_000,
  statementBytes: 16_384,
  validationTtlSeconds: 900,
};

const LIMIT_ENV: Readonly<Record<keyof ConnectorLimits, string>> = {
  casesPerBatch: "CONNECTOR_MAX_CASES_PER_BATCH",
  statementsPerCase: "CONNECTOR_MAX_STATEMENTS_PER_CASE",
  statementsPerBatch: "CONNECTOR_MAX_STATEMENTS_PER_BATCH",
  resultRowsPerStatement: "CONNECTOR_MAX_RESULT_ROWS",
  statementTimeoutMs: "CONNECTOR_STATEMENT_TIMEOUT_MS",
  statementBytes: "CONNECTOR_MAX_STATEMENT_BYTES",
  validationTtlSeconds: "CONNECTOR_VALIDATION_TTL_SECONDS",
};

export interface ConnectorConfig {
  /** Every route but `/healthz` requires `Authorization: Bearer <token>`. */
  token: string;
  /** libpq-style connection URL of the one database this connector executes on. */
  databaseUrl: string;
  host: string;
  port: number;
  /** The service's own append-only receipt store (SQLite). */
  receiptsPath: string;
  /** The name in the capabilities document. */
  name: string;
  limits: ConnectorLimits;
}

export const DEFAULT_PORT = 8790;
export const DEFAULT_RECEIPTS_PATH = "data/connector-postgres-receipts.sqlite";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") throw new Error(`${key} is required`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${key} must be a positive integer`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): ConnectorConfig {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_ENV) as (keyof ConnectorLimits)[]) {
    limits[key] = positiveInt(env, LIMIT_ENV[key], DEFAULT_LIMITS[key]);
  }
  const port = positiveInt(env, "PORT", DEFAULT_PORT);
  if (port > 65535) throw new Error("PORT must be at most 65535");
  return {
    token: required(env, "CONNECTOR_TOKEN"),
    databaseUrl: required(env, "CONNECTOR_DATABASE_URL"),
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    receiptsPath: env.CONNECTOR_RECEIPTS_PATH?.trim() || DEFAULT_RECEIPTS_PATH,
    name: env.CONNECTOR_NAME?.trim() || "postgres",
    limits,
  };
}
