// T1: `npm run dev:gateway` and `npm run auth` open the same database (PR #6 review finding 4).
// A relative GATEWAY_DB, such as `.env.example`'s `./data/gateway.sqlite`, must name one file no
// matter which directory a launcher is started from.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/gateway/src/db/open.ts";
import {
  GATEWAY_DB_DEFAULT,
  GATEWAY_DIR,
  REPO_ROOT,
  resolveGatewayDb,
} from "./gateway-dev-env.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local launcher database path", () => {
  it("resolves relative paths against the Gateway's working directory, once", () => {
    expect(resolveGatewayDb(undefined)).toBe(resolve(GATEWAY_DIR, GATEWAY_DB_DEFAULT));
    expect(resolveGatewayDb(" ./data/gateway.sqlite ")).toBe(
      resolve(GATEWAY_DIR, "data/gateway.sqlite"),
    );
    expect(resolveGatewayDb("/abs/db.sqlite")).toBe("/abs/db.sqlite");
    expect(resolveGatewayDb(":memory:")).toBe(":memory:");
  });

  it("both launchers use the shared resolution and the same working directory", () => {
    for (const script of ["dev-gateway.mjs", "auth-cli.mjs"]) {
      const source = readFileSync(join(REPO_ROOT, "scripts", script), "utf8");
      expect(source, script).toContain("gatewayChildEnv()");
      expect(source, script).toContain("cwd: GATEWAY_DIR");
    }
  });

  it("npm run auth with a relative GATEWAY_DB writes the database the dev Gateway opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-launcher-"));
    dirs.push(dir);
    const db = join(dir, "gateway.sqlite");
    openDatabase(db).close(); // what the dev Gateway's first start does
    const relativeDb = relative(GATEWAY_DIR, db);
    // Started from two different directories, the launcher must reach the same file.
    for (const [cwd, login] of [
      [REPO_ROOT, "admin"],
      [join(REPO_ROOT, "packages/web"), "second"],
    ]) {
      const command = login === "admin" ? "bootstrap-owner" : "create-user";
      const args = [join(REPO_ROOT, "scripts/auth-cli.mjs"), command, "--login", login];
      args.push("--name", login, ...(login === "admin" ? [] : ["--role", "member"]));
      const run = spawnSync(process.execPath, args, {
        cwd,
        env: {
          ...process.env,
          GATEWAY_DB: relativeDb,
          AUTH_ARGON2_MEMORY_KIB: "7168",
          AUTH_ARGON2_ITERATIONS: "1",
        },
        input: "a long enough password\na long enough password\n",
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(`Gateway database: ${db}`);
    }
    const check = new Database(db, { readonly: true });
    try {
      expect(check.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
    } finally {
      check.close();
    }
  }, 120_000);
});
