// T0, ADR-0046 decisions 2 to 4 and 8: observability is off with `OBSERVABILITY_SINK` unset; an
// unknown or not-yet-bundled sink id stops startup; the defaults are 300 s, 64 MiB, `full` and
// unlimited retention; the observability file can never be the ledger; the Grafana URL is read on
// its own and must be a loopback http origin (amendment 1 decision 11).

import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { OBSERVABILITY_DEFAULTS, readObservabilityConfig } from "./observability.js";

const read = (env: Record<string, string>) => readObservabilityConfig(env);

describe("observability configuration (ADR-0046)", () => {
  it("is off when OBSERVABILITY_SINK is unset or empty", () => {
    expect(read({})).toEqual({});
    expect(read({ OBSERVABILITY_SINK: "  ", OBSERVABILITY_PAYLOADS: "derived" })).toEqual({});
  });

  it("reads the sqlite sink with its defaults", () => {
    expect(read({ OBSERVABILITY_SINK: "sqlite" })).toEqual({
      observability: {
        sink: "sqlite",
        batchSeconds: OBSERVABILITY_DEFAULTS.batchSeconds,
        batchBytes: OBSERVABILITY_DEFAULTS.batchBytes,
        payloads: "full",
        retrospective: true,
      },
    });
    expect(OBSERVABILITY_DEFAULTS).toEqual({
      batchSeconds: 300,
      batchBytes: 64 * 1024 * 1024,
      payloads: "full",
    });
  });

  it("reads every variable", () => {
    expect(
      read({
        OBSERVABILITY_SINK: "sqlite",
        OBSERVABILITY_SQLITE_PATH: "/var/lib/deskmates/obs.sqlite",
        OBSERVABILITY_BATCH_SECONDS: "60",
        OBSERVABILITY_BATCH_BYTES: "1048576",
        OBSERVABILITY_PAYLOADS: "derived",
        OBSERVABILITY_RETENTION_DAYS: "30",
        OBSERVABILITY_RETROSPECTIVE: "off",
        OBSERVABILITY_GRAFANA_URL: "http://127.0.0.1:18700/",
      }),
    ).toEqual({
      observabilityGrafanaUrl: "http://127.0.0.1:18700",
      observability: {
        sink: "sqlite",
        sqlitePath: "/var/lib/deskmates/obs.sqlite",
        batchSeconds: 60,
        batchBytes: 1048576,
        payloads: "derived",
        retentionDays: 30,
        retrospective: false,
      },
    });
    expect(
      read({ OBSERVABILITY_SINK: "sqlite", OBSERVABILITY_RETENTION_DAYS: "0" }),
    ).not.toHaveProperty("observability.retentionDays");
  });

  it("refuses an unknown sink id, and names phase-two sinks as not bundled", () => {
    expect(() => read({ OBSERVABILITY_SINK: "duckdb" })).toThrow("must be one of: sqlite");
    for (const id of ["postgres", "forward"])
      expect(() => read({ OBSERVABILITY_SINK: id })).toThrow("not bundled in this release");
  });

  it("turns the retrospective on unless it is off (ADR-0046 amendment 2 decision 23)", () => {
    const base = { OBSERVABILITY_SINK: "sqlite" };
    expect(read(base).observability?.retrospective).toBe(true);
    expect(read({ ...base, OBSERVABILITY_RETROSPECTIVE: "on" }).observability?.retrospective).toBe(
      true,
    );
    expect(read({ ...base, OBSERVABILITY_RETROSPECTIVE: "OFF" }).observability?.retrospective).toBe(
      false,
    );
    expect(() => read({ ...base, OBSERVABILITY_RETROSPECTIVE: "1" })).toThrow("on or off");
  });

  it("refuses bad values", () => {
    const base = { OBSERVABILITY_SINK: "sqlite" };
    expect(() => read({ ...base, OBSERVABILITY_PAYLOADS: "some" })).toThrow("full or derived");
    expect(() => read({ ...base, OBSERVABILITY_BATCH_SECONDS: "0" })).toThrow("positive integer");
    expect(() => read({ ...base, OBSERVABILITY_BATCH_BYTES: "-1" })).toThrow("positive integer");
    expect(() => read({ ...base, OBSERVABILITY_RETENTION_DAYS: "x" })).toThrow("0 (off)");
    expect(() => read({ ...base, OBSERVABILITY_SQLITE_PATH: ":memory:" })).toThrow("a file");
  });

  it("never lets the observability file be the ledger", () => {
    expect(() =>
      read({
        OBSERVABILITY_SINK: "sqlite",
        GATEWAY_DB: "./data/gateway.sqlite",
        OBSERVABILITY_SQLITE_PATH: "data/gateway.sqlite",
      }),
    ).toThrow("must not be the Gateway database");
    expect(() =>
      read({ OBSERVABILITY_SINK: "sqlite", OBSERVABILITY_SQLITE_PATH: "./data/gateway.sqlite" }),
    ).toThrow("must not be the Gateway database");
  });

  it("reads the Grafana URL without a sink, as a loopback http origin only", () => {
    expect(read({ OBSERVABILITY_GRAFANA_URL: "http://127.0.0.1:18700" })).toEqual({
      observabilityGrafanaUrl: "http://127.0.0.1:18700",
    });
    for (const ok of ["http://localhost:18700/", "http://[::1]:18700"])
      expect(read({ OBSERVABILITY_GRAFANA_URL: ok }).observabilityGrafanaUrl).toBe(
        ok.replace(/\/$/, ""),
      );
    const refused: Array<[string, string]> = [
      ["not a url", "is not a URL"],
      ["ftp://127.0.0.1:18700", "must be http"],
      ["https://127.0.0.1:18700", "must be http"],
      ["http://u:p@127.0.0.1:18700", "credentials"],
      // A decision 6 value: the host's network address, which would carry the identity header
      // across a network to whoever answers there.
      ["http://ops.example.test:18700/", "host loopback"],
      ["http://10.0.0.5:18700", "host loopback"],
      ["http://127.0.0.1:18700/analytics/", "without a path"],
      ["http://127.0.0.1:18700/?x=1", "without a path"],
    ];
    for (const [raw, message] of refused)
      expect(() => read({ OBSERVABILITY_GRAFANA_URL: raw }), raw).toThrow(message);
  });

  it("is part of the Gateway configuration and stops startup on a bad sink", () => {
    const env = {
      GATEWAY_OPERATOR_TOKEN: "operator-token-123",
      MODEL_BASE_URL: "http://127.0.0.1:1",
      MODEL_AUTH_TOKEN: "t",
      DEFAULT_MODEL: "m",
      CHEAP_MODEL: "c",
    };
    expect(loadConfig({ ...env, OBSERVABILITY_SINK: "sqlite" }).observability?.sink).toBe("sqlite");
    expect(() => loadConfig({ ...env, OBSERVABILITY_SINK: "nope" })).toThrow("OBSERVABILITY_SINK");
  });
});
