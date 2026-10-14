import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, DEFAULT_PORT, loadConfig } from "./config.js";

const base = {
  CONNECTOR_TOKEN: "tok-secret-value",
  CONNECTOR_DATABASE_URL: "postgres://u:pw-secret@db:5432/x",
};

describe("loadConfig", () => {
  it("defaults the limits to the host adapter's and the port", () => {
    const c = loadConfig(base);
    expect(c.limits).toEqual(DEFAULT_LIMITS);
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.limits.validationTtlSeconds).toBe(900);
  });

  it("reads every limit from its variable", () => {
    const c = loadConfig({
      ...base,
      CONNECTOR_MAX_CASES_PER_BATCH: "5",
      CONNECTOR_MAX_STATEMENTS_PER_CASE: "7",
      CONNECTOR_MAX_STATEMENTS_PER_BATCH: "30",
      CONNECTOR_MAX_RESULT_ROWS: "50",
      CONNECTOR_STATEMENT_TIMEOUT_MS: "2500",
      CONNECTOR_MAX_STATEMENT_BYTES: "1000",
      CONNECTOR_VALIDATION_TTL_SECONDS: "60",
      PORT: "9000",
    });
    expect(c.limits).toEqual({
      casesPerBatch: 5,
      statementsPerCase: 7,
      statementsPerBatch: 30,
      resultRowsPerStatement: 50,
      statementTimeoutMs: 2500,
      statementBytes: 1000,
      validationTtlSeconds: 60,
    });
    expect(c.port).toBe(9000);
  });

  it("requires the token and the DSN and never echoes a secret in the error", () => {
    expect(() => loadConfig({ CONNECTOR_DATABASE_URL: base.CONNECTOR_DATABASE_URL })).toThrow(
      "CONNECTOR_TOKEN is required",
    );
    expect(() => loadConfig({ CONNECTOR_TOKEN: base.CONNECTOR_TOKEN })).toThrow(
      "CONNECTOR_DATABASE_URL is required",
    );
    try {
      loadConfig({ ...base, CONNECTOR_MAX_RESULT_ROWS: "pw-secret" });
    } catch (err) {
      expect(String(err)).not.toContain("pw-secret");
    }
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => loadConfig({ ...base, CONNECTOR_STATEMENT_TIMEOUT_MS: "0" })).toThrow(
      "CONNECTOR_STATEMENT_TIMEOUT_MS must be a positive integer",
    );
    expect(() => loadConfig({ ...base, CONNECTOR_MAX_RESULT_ROWS: "1.5" })).toThrow();
  });
});
