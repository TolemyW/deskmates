// T2: the connector against a real PostgreSQL 16 in Docker, over real HTTP with the real `pg`
// client. One validate/submit/receipt cycle with a mixed batch (DDL, INSERT, SELECT, a failing
// statement, a statement that outlives statement_timeout via pg_sleep), then a repeat submit that
// must return the same receipt and execute nothing, then a restart that keeps the receipt.
//
// Needs Docker and the postgres:16 image (pulled if absent). Skipped when `docker info` fails.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConnectorReceipt, parseConnectorValidation } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConnectorConfig, DEFAULT_LIMITS } from "./config.js";
import { createConnector } from "./index.js";

const IMAGE = process.env.CONNECTOR_T2_POSTGRES_IMAGE ?? "postgres:16";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const available = docker("info").status === 0;

const NAME = `connector-postgres-t2-${randomBytes(4).toString("hex")}`;
const PASSWORD = randomBytes(12).toString("hex");
const TOKEN = randomBytes(12).toString("hex");
let databaseUrl = "";
let dir = "";

async function waitForDatabase(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function config(): ConnectorConfig {
  return {
    token: TOKEN,
    databaseUrl,
    host: "127.0.0.1",
    port: 1,
    receiptsPath: join(dir, "receipts.sqlite"),
    name: "postgres16",
    limits: { ...DEFAULT_LIMITS, statementTimeoutMs: 1000 },
  };
}

async function start(): Promise<{ app: FastifyInstance; base: string }> {
  const app = createConnector({ config: config() });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  return { app, base: `http://127.0.0.1:${addr.port}` };
}

const call = async (base: string, method: "GET" | "POST", path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

// The image is pulled only when absent, and the pull is bounded: a host with no route to the
// registry (Testbox, where every release's verify runs) must skip this file quickly, not hang a
// beforeAll for its full timeout and fail the release gate for an environment reason.
const PULL_TIMEOUT_MS = 60_000;
const imageAvailable: boolean =
  available &&
  (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0 ||
    spawnSync("docker", ["pull", IMAGE], { stdio: "ignore", timeout: PULL_TIMEOUT_MS }).status ===
      0);

describe.skipIf(!imageAvailable)("connector-postgres against PostgreSQL 16", () => {
  beforeAll(async () => {
    const run = docker(
      "run",
      "-d",
      "--rm",
      "--name",
      NAME,
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-e",
      "POSTGRES_DB=connector_t2",
      "-p",
      "127.0.0.1::5432",
      IMAGE,
    );
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
    const port = docker("port", NAME, "5432/tcp").stdout.trim().split("\n")[0]?.split(":").pop();
    databaseUrl = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/connector_t2`;
    await waitForDatabase(databaseUrl);
    dir = mkdtempSync(join(tmpdir(), "connector-postgres-t2-"));
  }, 180_000);

  afterAll(() => {
    docker("rm", "-f", NAME);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs a mixed batch, records every statement, and never executes a repeat", async () => {
    const submission = {
      batch_id: "t2",
      cases: [
        {
          id: "mixed",
          source: "postgres/src/test/regress/sql/insert.sql",
          adaptation: "T2 fixture",
          steps: [
            "CREATE TABLE t2_items (a int PRIMARY KEY, b text)",
            "INSERT INTO t2_items VALUES (1, 'one'), (2, NULL)",
            "SELECT a, b FROM t2_items ORDER BY a",
            "INSERT INTO t2_items VALUES (1, 'duplicate')",
            "SELECT pg_sleep(5)",
            "SELECT count(*) FROM t2_items",
          ],
        },
      ],
    };
    const first = await start();
    const v = parseConnectorValidation(
      (await call(first.base, "POST", "/validate", { submission })).json,
    );
    expect(v).toMatchObject({ valid: true, effect: "external" });
    const submit = {
      validationId: v.validationId,
      contentHash: v.contentHash,
      idempotencyKey: "t2",
    };
    const accepted = parseConnectorReceipt(
      (await call(first.base, "POST", "/submit", submit)).json,
    );
    expect(accepted).toMatchObject({ status: "accepted", version: 1 });

    let receipt: Record<string, unknown> = {};
    const deadline = Date.now() + 30_000;
    for (;;) {
      receipt = (await call(first.base, "GET", `/receipt/${accepted.receiptId}`)).json;
      if (receipt.status === "succeeded" || receipt.status === "failed") break;
      if (Date.now() > deadline) throw new Error("receipt did not finish");
      await new Promise((r) => setTimeout(r, 200));
    }
    // The pg_sleep statement is uncertain, so the batch is failed; nothing stopped the case.
    expect(parseConnectorReceipt(receipt)).toMatchObject({ status: "failed", version: 3 });
    const statements = (receipt.cases as { statements: Record<string, unknown>[] }[])[0]
      ?.statements;
    expect(statements?.map((s) => s.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
      "error",
      "uncertain",
      "ok",
    ]);
    expect(statements?.[2]).toMatchObject({
      rows: [
        ["1", "one"],
        ["2", null],
      ],
      columns: [
        { name: "a", typeOid: 23 },
        { name: "b", typeOid: 25 },
      ],
    });
    expect(statements?.[3]?.error).toMatchObject({ sqlstate: "23505" });
    expect(statements?.[4]?.error).toMatchObject({ sqlstate: "57014" });
    expect(statements?.[5]?.rows).toEqual([["2"]]);
    expect(JSON.stringify(receipt)).not.toContain(PASSWORD);

    const again = parseConnectorReceipt((await call(first.base, "POST", "/submit", submit)).json);
    expect(again).toMatchObject({ receiptId: accepted.receiptId, version: 3 });
    await first.app.close();

    // A restart keeps the receipt and the idempotency key; the table shows one execution.
    const second = await start();
    const kept = parseConnectorReceipt(
      (await call(second.base, "GET", `/status/${accepted.receiptId}`)).json,
    );
    expect(kept).toMatchObject({ status: "failed", version: 3 });
    const repeat = parseConnectorReceipt((await call(second.base, "POST", "/submit", submit)).json);
    expect(repeat.receiptId).toBe(accepted.receiptId);
    await second.app.close();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const count = await client.query("SELECT count(*)::int AS n FROM t2_items");
    await client.end();
    expect(count.rows[0]?.n).toBe(2);
  }, 90_000);
});
