#!/usr/bin/env node
// @deskmates/connector-postgres entry point (`deskmates-connector-postgres`). Reads its configuration
// from the environment, opens its receipt store, finishes what a previous process left, and
// serves the ADR-0012 contract on PORT. It never logs the DSN or the token.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { BatchRunner } from "./batch-runner.js";
import { type ConnectorConfig, loadConfig } from "./config.js";
import { openReceiptsDb } from "./db/open-receipts-db.js";
import { pgSessionFactory } from "./pg-session.js";
import { ReceiptStore } from "./receipt-store.js";
import { buildService } from "./service.js";
import type { SqlSessionFactory } from "./sql-session.js";

export { type ConnectorConfig, type ConnectorLimits, loadConfig } from "./config.js";
export { buildService, type ServiceOptions } from "./service.js";

/** The strings no recorded error message may contain: the DSN and its password. */
export function secretsOf(databaseUrl: string): string[] {
  const out = [databaseUrl];
  try {
    const password = new URL(databaseUrl).password;
    if (password) out.push(password, decodeURIComponent(password));
  } catch {
    // Not a URL (a libpq keyword string): the whole string is still redacted.
  }
  return out;
}

export interface ConnectorOptions {
  config: ConnectorConfig;
  /** Defaults to `pg` against `config.databaseUrl`; T2 tests use the default too. */
  sessions?: SqlSessionFactory;
  logger?: boolean;
}

/**
 * The whole service wired together: receipt store, runner and routes. On ready it recovers what
 * a previous process left; on close it waits for the running batch, then closes the store.
 */
export function createConnector(opts: ConnectorOptions): FastifyInstance {
  const { config } = opts;
  const db = openReceiptsDb(config.receiptsPath);
  const store = new ReceiptStore(db);
  let warn: (msg: string, data?: Record<string, unknown>) => void = () => {};
  const runner = new BatchRunner({
    store,
    sessions: opts.sessions ?? pgSessionFactory(config.databaseUrl),
    limits: config.limits,
    secrets: secretsOf(config.databaseUrl),
    log: (msg, data) => warn(msg, data),
  });
  const app = buildService({ config, store, runner, logger: opts.logger ?? false });
  warn = (msg, data) => app.log.warn(data ?? {}, msg);
  app.addHook("onReady", async () => runner.recover());
  app.addHook("onClose", async () => {
    await runner.whenIdle();
    db.close();
  });
  return app;
}

async function main(): Promise<void> {
  let config: ConnectorConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // loadConfig's messages name variables, never their values.
    process.stderr.write(`deskmates-connector-postgres: ${(err as Error).message}\n`);
    process.exit(2);
  }
  const app = createConnector({ config, logger: true });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await app.listen({ host: config.host, port: config.port });
}

function invokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err: unknown) => {
    // Only the error's class: a connection error message could name the database host.
    process.stderr.write(
      `deskmates-connector-postgres: failed to start (${err instanceof Error ? err.name : "error"})\n`,
    );
    process.exit(1);
  });
}
