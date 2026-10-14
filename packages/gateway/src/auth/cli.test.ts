// T1: ADR-0022 decision 2 / test plan AUTH-01, AUTH-04. The maintenance CLI is the only way to
// create the first Owner; it refuses a replayed bootstrap, reads passwords from stdin only, and
// its revocations are durable for a running Gateway to observe.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { AuthService } from "./auth-service.js";
import { type CliIo, runAuthCli } from "./cli.js";

const PASSWORD = "correct horse battery staple";
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskmates-auth-cli-"));
  dbPath = join(dir, "gateway.sqlite");
  // The Gateway creates and migrates its database on first start; the CLI only opens one.
  openDatabase(dbPath).close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function io(passwords: string[]): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    env: {
      GATEWAY_DB: dbPath,
      AUTH_ARGON2_MEMORY_KIB: "7168",
      AUTH_ARGON2_ITERATIONS: "1",
    },
    stdout,
    stderr,
    readPassword: async () => {
      const next = passwords.shift();
      if (next === undefined) throw new Error("no password");
      return next;
    },
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

function service() {
  const db = openDatabase(dbPath);
  return { db, auth: new AuthService(db, { liveSweepMs: 0 }) };
}

describe("auth CLI", () => {
  it("names the database it opens and never creates a missing one", async () => {
    const missing = join(dir, "not-the-gateway.sqlite");
    const wrong = io([PASSWORD, PASSWORD]);
    wrong.env.GATEWAY_DB = missing;
    expect(await runAuthCli(["bootstrap-owner", "--name", "O"], wrong)).toBe(1);
    expect(wrong.stderr.join("\n")).toContain(`No Gateway database at ${missing}`);
    expect(existsSync(missing)).toBe(false);

    // A relative GATEWAY_DB resolves against the working directory, as the Gateway's does.
    const right = io([PASSWORD, PASSWORD]);
    right.env.GATEWAY_DB = relative(process.cwd(), dbPath);
    expect(await runAuthCli(["bootstrap-owner", "--name", "O"], right)).toBe(0);
    expect(right.stderr).toContain(`Gateway database: ${dbPath}`);
  });

  it("bootstraps the first Owner exactly once", async () => {
    const first = io([PASSWORD, PASSWORD]);
    expect(await runAuthCli(["bootstrap-owner", "--name", "Owner"], first)).toBe(0);
    expect(first.stdout.join("\n")).toMatch(/Created Owner usr_/);
    const replay = io([PASSWORD, PASSWORD]);
    expect(await runAuthCli(["bootstrap-owner", "--name", "Eve"], replay)).toBe(1);
    expect(replay.stderr.join("\n")).toMatch(/bootstrap is closed/);
    const { db, auth } = service();
    try {
      expect(auth.users.userCount()).toBe(1);
      await expect(auth.login("admin", PASSWORD, "cli")).resolves.toBeDefined();
      // The hash carries the parameters the CLI was configured with.
      expect(
        (
          db.prepare("SELECT password_hash FROM local_credentials").get() as {
            password_hash: string;
          }
        ).password_hash,
      ).toContain("m=7168,t=1,p=1");
    } finally {
      db.close();
    }
  });

  it("bootstrap-owner creates the root as admin (ADR-0022 amendment 6 W2)", async () => {
    const other = io([PASSWORD, PASSWORD]);
    expect(await runAuthCli(["bootstrap-owner", "--login", "eve"], other)).toBe(2);
    expect(other.stderr.join("\n")).toMatch(/always "admin"/);
    const ok = io([PASSWORD, PASSWORD]);
    expect(await runAuthCli(["bootstrap-owner"], ok)).toBe(0);
    const { db, auth } = service();
    try {
      const login = auth.users.findLocalLogin("admin");
      expect(login).toBeDefined();
      expect(auth.users.isProtected(login?.userId as string)).toBe(true);
      expect(auth.users.findLocalLogin("eve")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses mismatched or short passwords and missing options", async () => {
    expect(await runAuthCli(["bootstrap-owner", "--name", "O"], io([PASSWORD, "other"]))).toBe(2);
    expect(await runAuthCli(["bootstrap-owner", "--name", "O"], io(["short", "short"]))).toBe(1);
    expect(await runAuthCli(["bootstrap-owner", "--login", "x"], io([]))).toBe(2);
    expect(await runAuthCli(["no-such-command"], io([]))).toBe(2);
    const { db, auth } = service();
    expect(auth.users.userCount()).toBe(0);
    db.close();
  });

  it("accepts a short password only when GATEWAY_PASSWORD_MIN_LENGTH allows it", async () => {
    const relaxed = io(["admin", "admin"]);
    relaxed.env.GATEWAY_PASSWORD_MIN_LENGTH = "5";
    expect(await runAuthCli(["bootstrap-owner", "--name", "Admin"], relaxed)).toBe(0);
    const strict = io(["admin", "admin"]);
    expect(
      await runAuthCli(
        ["create-user", "--login", "bob", "--name", "Bob", "--role", "member"],
        strict,
      ),
    ).toBe(1);
    expect(strict.stderr.join("\n")).toContain("at least 12 characters");
    const { db } = service();
    const auth = new AuthService(db, { liveSweepMs: 0, passwordMinLength: 5 });
    expect(auth.users.userCount()).toBe(1);
    db.close();
  });

  it("creates users, resets passwords and disables accounts with session revocation", async () => {
    await runAuthCli(["bootstrap-owner", "--name", "Owner"], io([PASSWORD, PASSWORD]));
    expect(
      await runAuthCli(
        ["create-user", "--login", "bob", "--name", "Bob", "--role", "member"],
        io([PASSWORD, PASSWORD]),
      ),
    ).toBe(0);
    expect(
      await runAuthCli(
        ["create-user", "--login", "bob2", "--name", "Bob", "--role", "root"],
        io([PASSWORD, PASSWORD]),
      ),
    ).toBe(2);

    let { db, auth } = service();
    const bob = await auth.login("bob", PASSWORD, "cli");
    expect(auth.resolve(bob.token)?.principal.role).toBe("guest"); // no workspace exists yet: no workspace role (ADR-0022 amendment 6 W1)
    db.close();

    const reset = io(["a different password", "a different password"]);
    expect(await runAuthCli(["reset-password", "--login", "bob"], reset)).toBe(0);
    expect(reset.stdout.join("\n")).toContain("1 session(s) revoked");
    ({ db, auth } = service());
    expect(auth.resolve(bob.token)).toBeUndefined();
    const again = await auth.login("bob", "a different password", "cli");
    db.close();

    const disable = io([]);
    expect(await runAuthCli(["disable-user", "--login", "bob"], disable)).toBe(0);
    expect(disable.stdout.join("\n")).toContain("1 session(s) revoked");
    ({ db, auth } = service());
    expect(auth.resolve(again.token)).toBeUndefined();
    await expect(auth.login("bob", "a different password", "cli")).rejects.toThrow();
    db.close();

    expect(await runAuthCli(["enable-user", "--login", "bob"], io([]))).toBe(0);
    const list = io([]);
    expect(await runAuthCli(["list-users"], list)).toBe(0);
    expect(list.stdout.join("\n")).toMatch(/admin\tactive\towner\/active\tOwner/);
    // No workspace exists yet, so Bob holds no workspace role (ADR-0022 amendment 6 W1).
    expect(list.stdout.join("\n")).toMatch(/bob\tactive\tguest\/active\tBob/);
    expect(list.stdout.join("\n")).not.toMatch(/argon2/);
  });

  it("manages tenants, memberships, OIDC providers and tenant SSO policy (platform only)", async () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    let multi = false;
    const run = async (argv: string[], secrets: string[] = []) => {
      const cli = io(secrets);
      cli.env.GATEWAY_SECRETS_KEY = key;
      if (multi) cli.env.DESKMATES_TENANCY = "multi";
      const code = await runAuthCli(argv, cli);
      return { code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n") };
    };
    expect((await run(["bootstrap-owner", "--name", "Owner"], [PASSWORD, PASSWORD])).code).toBe(0);
    // A single-tenant deployment refuses a second tenant outright.
    const single = await run(["create-tenant", "--name", "Tenant B"]);
    expect(single.code).toBe(1);
    expect(single.err).toContain("single-tenant");
    multi = true;
    expect((await run(["preflight"])).out).toContain("ready for DESKMATES_TENANCY=multi");
    const created = await run(["create-tenant", "--name", "Tenant B"]);
    expect(created.code).toBe(0);
    const tenantId = /Created tenant (\S+)/.exec(created.out)?.[1] as string;
    expect(
      (await run(["add-member", "--tenant", tenantId, "--login", "admin", "--role", "admin"])).code,
    ).toBe(0);

    // A confidential client: the secret comes from stdin and is stored encrypted, never echoed.
    const added = await run(
      [
        "add-oidc-provider",
        "--id",
        "corp",
        "--name",
        "Corp SSO",
        "--issuer",
        "https://idp.example.com/realm",
        "--client-id",
        "deskmates",
        "--redirect-uri",
        "https://deskmates.example.com/auth/oidc/callback",
      ],
      ["top-secret-client-value"],
    );
    expect(added.code).toBe(0);
    const providers = await run(["list-oidc-providers"]);
    expect(providers.out).toContain(
      "corp\tactive\thttps://idp.example.com/realm\tdeskmates\tconfidential",
    );
    expect(providers.out + providers.err + added.out).not.toContain("top-secret-client-value");
    const { db } = service();
    const blob = db
      .prepare("SELECT encrypted_blob FROM secrets WHERE owner_kind = 'oidc_provider'")
      .get() as { encrypted_blob: Buffer };
    expect(blob.encrypted_blob.toString("utf8")).not.toContain("top-secret-client-value");
    db.close();
    // Plain HTTP issuers and arbitrary callback paths are refused.
    const insecure = await run([
      "add-oidc-provider",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--issuer",
      "http://idp.example.com",
      "--client-id",
      "x",
      "--redirect-uri",
      "https://deskmates.example.com/auth/oidc/callback",
      "--public",
    ]);
    expect(insecure.code).toBe(1);
    const badRedirect = await run([
      "add-oidc-provider",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--issuer",
      "https://idp2.example.com",
      "--client-id",
      "x",
      "--redirect-uri",
      "https://deskmates.example.com/elsewhere",
      "--public",
    ]);
    expect(badRedirect.code).toBe(1);
    // JIT is bounded to Member.
    expect(
      (await run(["link-tenant-sso", "--tenant", tenantId, "--provider", "corp", "--jit", "owner"]))
        .code,
    ).toBe(2);
    const linked = await run([
      "link-tenant-sso",
      "--tenant",
      tenantId,
      "--provider",
      "corp",
      "--jit",
      "member",
      "--max-auth-age",
      "3600",
    ]);
    expect(linked.out).toContain("max auth age 3600s, JIT member");
    const policy = await run([
      "set-tenant-policy",
      "--tenant",
      tenantId,
      "--policy",
      "sso_required",
    ]);
    expect(policy.out).toContain("sso_required (version 2)");
    const tenants = await run(["list-tenants"]);
    expect(tenants.out).toContain(`${tenantId}\tactive\tsso_required@v2\tTenant B`);
    expect(tenants.out).toContain("tnt_default\tactive\tlocal_or_sso@v1\tDefault Tenant");
    expect(
      (await run(["set-tenant-status", "--tenant", tenantId, "--status", "suspended"])).out,
    ).toContain("suspended");
    expect(
      (await run(["unlink-tenant-sso", "--tenant", tenantId, "--provider", "corp"])).out,
    ).toContain("Unlinked");
  });

  // Issue #14 item 3: platform maintenance is granted and revoked from the CLI only, by local
  // login name, SSO email or user id, and the last maintainer can never be revoked.
  it("grants and revokes platform maintenance, keeping at least one maintainer", async () => {
    const run = async (argv: string[], secrets: string[] = []) => {
      const cli = io(secrets);
      const code = await runAuthCli(argv, cli);
      return { code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n") };
    };
    await run(["bootstrap-owner", "--name", "Owner"], [PASSWORD, PASSWORD]);
    await run(
      ["create-user", "--login", "bob", "--name", "Bob", "--role", "member"],
      [PASSWORD, PASSWORD],
    );
    const { db, auth } = service();
    const sso = auth.users.createOidcUser({
      displayName: "Carol",
      issuer: "https://idp.example.com/realm",
      subject: "opaque-subject-1",
      email: "Carol@Example.com",
      emailVerified: true,
      tenantId: "tnt_default",
    });
    const bobId = auth.users.findLocalLogin("bob")?.userId as string;
    const ownerId = auth.users.findLocalLogin("admin")?.userId as string;
    db.close();
    const platformRoles = () => {
      const opened = service();
      const role = (id: string) => opened.auth.users.getUser(id)?.platformRole ?? null;
      const roles = { owner: role(ownerId), bob: role(bobId), carol: role(sso.user.id) };
      opened.db.close();
      return roles;
    };

    // The bootstrap Owner is the only maintainer; revoking it would leave nobody.
    const last = await run(["revoke-maintainer", "admin"]);
    expect(last.code).toBe(1);
    expect(last.err).toContain("last platform maintainer");

    const granted = await run(["grant-maintainer", "bob"]);
    expect(granted.code).toBe(0);
    expect(granted.out).toContain("Bob");
    expect((await run(["grant-maintainer", "--login", "BOB"])).out).toContain("already");
    // An SSO person has no local login: named by email or by user id.
    expect((await run(["grant-maintainer", "carol@example.com"])).code).toBe(0);
    expect(platformRoles()).toEqual({
      owner: "maintainer",
      bob: "maintainer",
      carol: "maintainer",
    });
    const listed = await run(["list-users"]);
    expect(listed.out).toMatch(/bob\tactive\tguest\/active\tBob\tmaintainer/);

    expect((await run(["revoke-maintainer", sso.user.id])).code).toBe(0);
    expect((await run(["revoke-maintainer", "admin"])).code).toBe(0);
    expect((await run(["revoke-maintainer", "admin"])).out).toContain("not a platform maintainer");
    expect((await run(["revoke-maintainer", "bob"])).code).toBe(1);
    expect(platformRoles()).toEqual({ owner: null, bob: "maintainer", carol: null });

    // A disabled maintainer does not count as the one who keeps the installation. (The bootstrap
    // Owner is the protected root account, which can never be disabled: ADR-0031 decision 8.)
    expect(await run(["disable-user", "--login", "admin"])).toMatchObject({ code: 1 });
    await run(
      ["create-user", "--login", "dan", "--name", "Dan", "--role", "member"],
      [PASSWORD, PASSWORD],
    );
    await run(["grant-maintainer", "dan"]);
    await run(["disable-user", "--login", "dan"]);
    expect((await run(["revoke-maintainer", "bob"])).code).toBe(1);
    expect(platformRoles().bob).toBe("maintainer");

    expect((await run(["grant-maintainer", "nobody"])).code).toBe(2);
    expect((await run(["grant-maintainer"])).code).toBe(2);
  });
});
