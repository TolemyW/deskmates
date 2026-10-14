// T1: maintenance CLI equivalents of the service principal Admin routes (ADR-0022 amendment 2),
// and a restore clearing every service principal token like every other credential.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { AuthService } from "./auth-service.js";
import { type CliIo, runAuthCli } from "./cli.js";
import { DEFAULT_TENANT_ID } from "./user-store.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskmates-sp-cli-"));
  dbPath = join(dir, "gateway.sqlite");
  openDatabase(dbPath).close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function io(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    env: { GATEWAY_DB: dbPath },
    stdout,
    stderr,
    readPassword: async () => {
      throw new Error("no password expected");
    },
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

/** Whether a token resolves, read through a fresh service like a running Gateway would. */
function resolves(token: string): boolean {
  const db = openDatabase(dbPath);
  try {
    return new AuthService(db, { liveSweepMs: 0 }).resolveServiceToken(token) !== undefined;
  } finally {
    db.close();
  }
}

function printedToken(lines: string[]): string {
  const line = lines.find((l) => l.startsWith("Token (shown once): "));
  expect(line).toBeDefined();
  return (line as string).slice("Token (shown once): ".length);
}

describe("service principal CLI", () => {
  it("creates, lists, rotates and disables; each change applies to the next resolution", async () => {
    const create = io();
    expect(
      await runAuthCli(
        [
          "create-service-principal",
          "--tenant",
          DEFAULT_TENANT_ID,
          "--name",
          "release-agent",
          "--daily-usd-cap",
          "2.5",
        ],
        create,
      ),
    ).toBe(0);
    const token = printedToken(create.stdout);
    const id = /service principal (svc_[a-f0-9]+)/.exec(create.stdout[0] ?? "")?.[1] as string;
    expect(id).toBeDefined();
    expect(resolves(token)).toBe(true);

    const list = io();
    expect(await runAuthCli(["list-service-principals", "--tenant", DEFAULT_TENANT_ID], list)).toBe(
      0,
    );
    expect(list.stdout.join("\n")).toContain(id);
    expect(list.stdout.join("\n")).toContain("usd/day<=2.5");
    expect(list.stdout.join("\n")).not.toContain("runs<=");
    expect(list.stdout.join("\n")).not.toContain(token);

    const rotate = io();
    expect(await runAuthCli(["rotate-service-principal", "--id", id], rotate)).toBe(0);
    const next = printedToken(rotate.stdout);
    expect(resolves(token)).toBe(false);
    expect(resolves(next)).toBe(true);

    const disable = io();
    expect(await runAuthCli(["disable-service-principal", "--id", id], disable)).toBe(0);
    expect(resolves(next)).toBe(false);
    const again = io();
    expect(await runAuthCli(["rotate-service-principal", "--id", id], again)).toBe(1);
  });

  it("creates a Member by default or an Admin with --role, shows the role, refuses owner (ADR-0022 amendment 1 A10)", async () => {
    const member = io();
    expect(
      await runAuthCli(
        ["create-service-principal", "--tenant", DEFAULT_TENANT_ID, "--name", "reader"],
        member,
      ),
    ).toBe(0);
    expect(member.stdout[0]).toContain("as member of");
    const admin = io();
    expect(
      await runAuthCli(
        [
          "create-service-principal",
          "--tenant",
          DEFAULT_TENANT_ID,
          "--name",
          "builder",
          "--role",
          "admin",
        ],
        admin,
      ),
    ).toBe(0);
    expect(admin.stdout[0]).toContain("as admin of");
    const list = io();
    expect(await runAuthCli(["list-service-principals"], list)).toBe(0);
    const rows = list.stdout.map((line) => line.split("\t"));
    expect(rows.find((row) => row.at(-1) === "reader")).toContain("member");
    expect(rows.find((row) => row.at(-1) === "builder")).toContain("admin");
    const owner = io();
    expect(
      await runAuthCli(
        [
          "create-service-principal",
          "--tenant",
          DEFAULT_TENANT_ID,
          "--name",
          "x",
          "--role",
          "owner",
        ],
        owner,
      ),
    ).toBe(1);
    expect(owner.stderr.join("\n")).toContain("role");
  });

  it("refuses missing options, a bad budget, an unknown tenant or principal", async () => {
    const missing = io();
    expect(await runAuthCli(["create-service-principal", "--name", "x"], missing)).toBe(2);
    const badBudget = io();
    expect(
      await runAuthCli(
        [
          "create-service-principal",
          "--tenant",
          DEFAULT_TENANT_ID,
          "--name",
          "x",
          "--daily-usd-cap",
          "lots",
        ],
        badBudget,
      ),
    ).toBe(1);
    expect(badBudget.stderr.join("\n")).toContain("dailyUsdCap");
    const tenant = io();
    expect(
      await runAuthCli(["create-service-principal", "--tenant", "tnt_none", "--name", "x"], tenant),
    ).toBe(1);
    const unknown = io();
    expect(await runAuthCli(["disable-service-principal", "--id", "svc_none"], unknown)).toBe(1);
  });

  it("a restore clears every service principal token; rotation issues a working one", async () => {
    const create = io();
    await runAuthCli(
      ["create-service-principal", "--tenant", DEFAULT_TENANT_ID, "--name", "restored"],
      create,
    );
    const token = printedToken(create.stdout);
    const id = /service principal (svc_[a-f0-9]+)/.exec(create.stdout[0] ?? "")?.[1] as string;
    const backup = join(dir, "backup.sqlite");
    expect(await runAuthCli(["backup", "--out", backup], io())).toBe(0);
    const restore = io();
    expect(await runAuthCli(["restore", "--from", backup], restore)).toBe(0);
    expect(restore.stdout.join("\n")).toContain("1 service principal token(s) cleared");
    expect(resolves(token)).toBe(false);
    const rotate = io();
    expect(await runAuthCli(["rotate-service-principal", "--id", id], rotate)).toBe(0);
    expect(resolves(printedToken(rotate.stdout))).toBe(true);
  });
});
