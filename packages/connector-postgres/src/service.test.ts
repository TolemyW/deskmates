// T1: the ADR-0012 HTTP contract served in-process. Responses are read with the same parsers the
// Gateway's ConnectorProxy applies (`parseConnector*` from contracts), so a shape the Gateway
// would refuse fails here first. The ConnectorProxy itself needs a full Gateway store stack and
// this package imports nothing but contracts, so it is mirrored rather than imported.

import { readFileSync } from "node:fs";
import {
  canonicalJson,
  parseConnectorCapabilities,
  parseConnectorReceipt,
  parseConnectorValidation,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BatchRunner } from "./batch-runner.js";
import { CONNECTOR_VERSION } from "./capabilities.js";
import { DEFAULT_LIMITS } from "./config.js";
import { contentHash } from "./content-hash.js";
import { openReceiptsDb } from "./db/open-receipts-db.js";
import { ReceiptStore } from "./receipt-store.js";
import { buildService } from "./service.js";
import { FakeSql, FakeSqlError, commandOf, rowsOf } from "./test-support/fake-sql.js";

const TOKEN = "connector-token-1";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function service(fake = new FakeSql(() => rowsOf([["1"]], ["a"])), clock?: () => number) {
  const store = new ReceiptStore(openReceiptsDb(":memory:"));
  const runner = new BatchRunner({ store, sessions: fake.factory, limits: DEFAULT_LIMITS });
  const app = buildService({
    config: { token: TOKEN, name: "vendordb", limits: DEFAULT_LIMITS },
    store,
    runner,
    ...(clock ? { clock } : {}),
  });
  apps.push(app);
  const call = (method: "GET" | "POST", url: string, body?: unknown, token = TOKEN) =>
    app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body === undefined ? {} : { payload: body as object }),
    });
  return { app, call, fake, runner };
}

const submission = {
  batch_id: "q01",
  cases: [
    {
      id: "cte_basic",
      source: "postgres/src/test/regress/sql/with.sql",
      adaptation: "none",
      steps: ["WITH x AS (SELECT 1 AS a) SELECT a FROM x;"],
    },
  ],
};

describe("connector-postgres HTTP contract", () => {
  it("answers /healthz without a token and every other route only with it", async () => {
    const { call } = service();
    expect((await call("GET", "/healthz", undefined, "")).statusCode).toBe(200);
    const denied = await call("POST", "/describe", {}, "wrong");
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ error: { code: "token_rejected" } });
    expect((await call("POST", "/validate", { submission }, "")).statusCode).toBe(401);
  });

  it("describes sql_batch with limits, schema and what it does not support", async () => {
    const { call } = service();
    const caps = parseConnectorCapabilities((await call("POST", "/describe", {})).json());
    expect(caps.name).toBe("vendordb");
    expect(caps.operations.map((o) => [o.name, o.effect])).toEqual([["sql_batch", "external"]]);
    expect(caps.limits).toMatchObject({
      casesPerBatch: 3,
      statementsPerCase: 10,
      statementsPerBatch: 20,
      resultRowsPerStatement: 200,
      statementTimeoutMs: 10_000,
    });
    expect(caps.submissionSchema.required).toEqual(["batch_id", "cases"]);
    expect(caps.unsupported.join("\n")).toMatch(/PROCEDURE/);
    expect(caps.unsupported.join("\n")).toMatch(/COPY/);
    expect(caps.unsupported.join("\n")).toMatch(/EXTENSION/);
    expect(caps.unsupported.join("\n")).toMatch(/COMMIT/);
  });

  it("keeps the advertised version equal to package.json's", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(CONNECTOR_VERSION).toBe(pkg.version);
  });

  it("validates with the Gateway's content hash, effect and summary", async () => {
    const { call } = service();
    const res = await call("POST", "/validate", {
      submission,
      contentHash: contentHash(submission),
    });
    const v = parseConnectorValidation(res.json());
    expect(v.valid).toBe(true);
    expect(v.effect).toBe("read");
    expect(v.contentHash).toBe(contentHash(submission));
    expect(v.summary).toBe("batch q01: 1 case, 1 statement, effect read (WITH 1)");
    expect(v.validationId).toMatch(/^val_/);
  });

  it("hashes the canonical JSON: key order does not change the hash", async () => {
    const { call } = service();
    const reordered = JSON.parse(
      JSON.stringify({ cases: submission.cases, batch_id: submission.batch_id }),
    );
    const a = parseConnectorValidation((await call("POST", "/validate", { submission })).json());
    const b = parseConnectorValidation(
      (await call("POST", "/validate", { submission: reordered })).json(),
    );
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.validationId).not.toBe(b.validationId);
    expect(canonicalJson(reordered)).toBe(canonicalJson(submission));
  });

  it("returns field-specific errors for an unsupported step", async () => {
    const { call } = service();
    const bad = {
      ...submission,
      cases: [{ ...submission.cases[0], steps: ["SELECT 1", "COMMIT"] }],
    };
    const v = parseConnectorValidation(
      (await call("POST", "/validate", { submission: bad })).json(),
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toEqual([
      expect.objectContaining({ path: "cases[0].steps[1]", code: "unsupported" }),
    ]);
  });

  it("refuses a validate body without a submission", async () => {
    const { call } = service();
    const res = await call("POST", "/validate", {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "validation" } });
  });

  it("refuses submit, status and receipt without the token", async () => {
    const { call } = service();
    expect((await call("POST", "/submit", {}, "")).statusCode).toBe(401);
    expect((await call("GET", "/status/x", undefined, "")).statusCode).toBe(401);
    expect((await call("GET", "/receipt/x", undefined, "")).statusCode).toBe(401);
  });
});

describe("submit, status and receipt", () => {
  const mixed = {
    batch_id: "d01",
    cases: [
      {
        id: "ddl_dml",
        source: "postgres/src/test/regress/sql/insert.sql",
        adaptation: "prefixed tables",
        steps: [
          "CREATE TABLE lc29_d01_t (a int)",
          "INSERT INTO lc29_d01_t VALUES (1)",
          "SELECT a FROM missing_table",
          "SELECT a FROM lc29_d01_t",
        ],
      },
    ],
  };

  function fakeDb() {
    return new FakeSql((sql) => {
      if (sql.startsWith("CREATE")) return commandOf("CREATE");
      if (sql.startsWith("INSERT")) return commandOf("INSERT", 1);
      if (sql.includes("missing_table"))
        return new FakeSqlError('relation "missing_table" does not exist', "42P01");
      return rowsOf([["1"]], ["a"]);
    });
  }

  async function validated(call: ReturnType<typeof service>["call"], body: unknown = mixed) {
    return parseConnectorValidation((await call("POST", "/validate", { submission: body })).json());
  }

  it("runs a validated batch: accepted, then running, then succeeded with per-statement results", async () => {
    const { call, fake, runner } = service(fakeDb());
    const v = await validated(call);
    expect(v.effect).toBe("external");
    const res = await call("POST", "/submit", {
      validationId: v.validationId,
      contentHash: v.contentHash,
      idempotencyKey: "k1",
    });
    expect(res.statusCode).toBe(200);
    const accepted = parseConnectorReceipt(res.json());
    expect(accepted).toMatchObject({
      status: "accepted",
      version: 1,
      contentHash: v.contentHash,
      validationId: v.validationId,
      idempotencyKey: "k1",
    });
    await runner.whenIdle();
    const status = parseConnectorReceipt(
      (await call("GET", `/status/${accepted.receiptId}`)).json(),
    );
    expect(status).toMatchObject({ status: "succeeded", version: 3 });
    const full = (await call("GET", `/receipt/${accepted.receiptId}`)).json();
    expect(parseConnectorReceipt(full).version).toBe(3);
    expect(full.versions.map((x: { status: string }) => x.status)).toEqual([
      "accepted",
      "running",
      "succeeded",
    ]);
    expect(full.cases[0].statements.map((s: { outcome: string }) => s.outcome)).toEqual([
      "ok",
      "ok",
      "error",
      "ok",
    ]);
    expect(full.cases[0].statements[2].error).toEqual({
      sqlstate: "42P01",
      message: 'relation "missing_table" does not exist',
    });
    expect(JSON.parse(full.detail).cases).toEqual(full.cases);
    expect(fake.executed).toHaveLength(4);
  });

  it("executes once per (contentHash, idempotencyKey) and returns the same receipt on a repeat", async () => {
    const { call, fake, runner } = service(fakeDb());
    const v = await validated(call);
    const submit = {
      validationId: v.validationId,
      contentHash: v.contentHash,
      idempotencyKey: "k1",
    };
    const first = parseConnectorReceipt((await call("POST", "/submit", submit)).json());
    const again = parseConnectorReceipt((await call("POST", "/submit", submit)).json());
    expect(again.receiptId).toBe(first.receiptId);
    await runner.whenIdle();
    const late = parseConnectorReceipt((await call("POST", "/submit", submit)).json());
    expect(late).toMatchObject({ receiptId: first.receiptId, status: "succeeded" });
    expect(fake.sessions).toHaveLength(1);
    expect(fake.executed).toHaveLength(4);
    const other = parseConnectorReceipt(
      (await call("POST", "/submit", { ...submit, idempotencyKey: "k2" })).json(),
    );
    expect(other.receiptId).not.toBe(first.receiptId);
  });

  it("uses the validation id as the key when none is given", async () => {
    const { call } = service(fakeDb());
    const v = await validated(call);
    const r = parseConnectorReceipt(
      (
        await call("POST", "/submit", { validationId: v.validationId, contentHash: v.contentHash })
      ).json(),
    );
    expect(r.idempotencyKey).toBe(v.validationId);
  });

  it("refuses an unknown validation, a mismatched hash and an invalid validation with typed errors", async () => {
    const { call, fake } = service(fakeDb());
    const missing = await call("POST", "/submit", {
      validationId: "val_nope",
      contentHash: "b".repeat(64),
      idempotencyKey: "k",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("connector_validation_missing");

    const v = await validated(call);
    const mismatch = await call("POST", "/submit", {
      validationId: v.validationId,
      contentHash: "b".repeat(64),
      idempotencyKey: "k",
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("connector_hash_mismatch");

    const bad = await validated(call, {
      ...mixed,
      cases: [{ ...mixed.cases[0], steps: ["BEGIN"] }],
    });
    const invalid = await call("POST", "/submit", {
      validationId: bad.validationId,
      contentHash: bad.contentHash,
      idempotencyKey: "k",
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error.code).toBe("connector_validation_invalid");
    expect(fake.executed).toEqual([]);
  });

  it("refuses a validation older than the TTL", async () => {
    let now = 1_000_000;
    const { call, fake } = service(fakeDb(), () => now);
    const v = await validated(call);
    now += DEFAULT_LIMITS.validationTtlSeconds * 1000;
    const res = await call("POST", "/submit", {
      validationId: v.validationId,
      contentHash: v.contentHash,
      idempotencyKey: "k",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("connector_validation_stale");
    expect(fake.executed).toEqual([]);
  });

  it("refuses a malformed submit body", async () => {
    const { call } = service();
    expect((await call("POST", "/submit", { contentHash: "a".repeat(64) })).statusCode).toBe(400);
    expect(
      (await call("POST", "/submit", { validationId: "v", contentHash: "x" })).statusCode,
    ).toBe(400);
  });

  it("answers 404 for a receipt it never issued", async () => {
    const { call } = service();
    expect((await call("GET", "/status/rcpt_nope")).statusCode).toBe(404);
    expect((await call("GET", "/receipt/rcpt_nope")).json().error.code).toBe("not_found");
  });
});
