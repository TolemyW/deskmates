// Shared by the local launchers (`npm run dev:gateway`, `npm run auth`) so the development
// Gateway and the sign-in maintenance CLI read the same `.env` and open the same database file.
// Before this, a relative GATEWAY_DB resolved against each process's own working directory, and
// `npm run auth` could bootstrap an account in a database the running Gateway never opened.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Working directory of every local Gateway process; relative paths in `.env` resolve here. */
export const GATEWAY_DIR = resolve(REPO_ROOT, "packages/gateway");
export const GATEWAY_DB_DEFAULT = "./data/gateway.sqlite";

/**
 * Load the repo-root `.env` (the documented location), then `packages/gateway/.env` if present.
 * Values already in the environment win, and the first file wins over the second.
 */
export function loadDevEnv() {
  const loaded = [];
  for (const file of [resolve(REPO_ROOT, ".env"), resolve(GATEWAY_DIR, ".env")]) {
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
    loaded.push(file);
  }
  return loaded;
}

/** The one absolute database path every local launcher hands its child process. */
export function resolveGatewayDb(raw) {
  const value = raw?.trim() || GATEWAY_DB_DEFAULT;
  if (value === ":memory:" || isAbsolute(value)) return value;
  return resolve(GATEWAY_DIR, value);
}

/** Environment for a local Gateway-side child process: `.env` loaded, GATEWAY_DB absolute. */
export function gatewayChildEnv() {
  loadDevEnv();
  process.env.GATEWAY_DB = resolveGatewayDb(process.env.GATEWAY_DB);
  return process.env;
}
