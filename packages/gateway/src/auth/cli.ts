// Platform maintenance CLI for sign-in accounts (ADR-0022 P1). The protected root account is
// created at first start with a password it must change (ADR-0031 decision 8). Passwords are
// read from stdin, never from argv (which `ps` and shell history would expose).
//
//   node packages/gateway/dist/auth/cli.js create-root     (the Gateway also does this at first start)
//   node packages/gateway/dist/auth/cli.js create-user --login bob --name Bob --role member
//   node packages/gateway/dist/auth/cli.js reset-password --login bob
//   node packages/gateway/dist/auth/cli.js disable-user --login bob     (enable-user to undo)
//   node packages/gateway/dist/auth/cli.js revoke-sessions --login bob
//   node packages/gateway/dist/auth/cli.js list-users
//   node packages/gateway/dist/auth/cli.js add-oidc-provider --id corp --name "Corp SSO" \
//     --issuer https://idp.example.com --client-id deskmates \
//     --redirect-uri https://deskmates.example.com/auth/oidc/callback
//   node packages/gateway/dist/auth/cli.js link-tenant-sso --tenant tnt_default --provider corp
//   node packages/gateway/dist/auth/cli.js set-tenant-policy --tenant tnt_default --policy sso_required
//   node packages/gateway/dist/auth/cli.js grant-maintainer bob     (revoke-maintainer to undo)
//
// Tenants, SSO providers and tenant policy are platform maintenance (ADR-0022): no tenant role
// reaches them over HTTP. An OIDC client secret is read from stdin like a password and stored
// encrypted with GATEWAY_SECRETS_KEY; `--public` registers a PKCE-only client with none.
//
// It opens `GATEWAY_DB` (default ./data/gateway.sqlite) resolved against the working directory,
// exactly as the Gateway does, so run it from the Gateway's working directory (a deployment's
// shared directory) or through `npm run auth` in a checkout, which matches `npm run dev:gateway`.
// It prints the absolute file it opened and refuses a missing one. A running Gateway notices a
// revocation on the next request and closes the session's live streams within one sweep.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { TENANT_ROLES, type TenantRole, isDeskmatesError } from "@deskmates/contracts";
import { authConfig } from "../config.js";
import { backupDatabase, manifestPath, restoreDatabase } from "../db/backup.js";
import { openDatabase } from "../db/open.js";
import { invokedDirectly } from "../invoked-directly.js";
import { SecretsStore } from "../secrets/secrets-store.js";
import { parseTenancyMode, tenancyPreflight } from "../tenancy/tenancy-mode.js";
import { AuthService, PROTECTED_ROOT_LOGIN } from "./auth-service.js";
import { OidcStore } from "./oidc-store.js";
import { SERVICE_PRINCIPAL_USAGE, runServicePrincipalCommand } from "./service-principal-cli.js";
import {
  DEFAULT_TENANT_ID,
  type TenantAuthPolicy,
  type User,
  normalizeLoginName,
} from "./user-store.js";

export interface CliIo {
  env: NodeJS.ProcessEnv;
  /** Read one password; the prompt is shown on a terminal and ignored for piped input. */
  readPassword(prompt: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `usage: auth-cli <command> [options]
  bootstrap-owner [--name <display name>]               create the root account "admin" (once)
  create-root                                            the same as login admin, password admin
  create-user --login <name> --name <display> --role <owner|admin|member> [--tenant <id>]
  reset-password --login <name>                          set a password, revoke all sessions
  disable-user --login <name> | enable-user --login <name>
  revoke-sessions --login <name>                         sign the user out everywhere
  list-users [--tenant <id>]                             a trailing "maintainer" marks platform maintenance
  grant-maintainer <login> | revoke-maintainer <login>   platform maintenance for an existing user;
                                                         <login> is a local login name, a verified
                                                         SSO email or a user id; the last active
                                                         maintainer cannot be revoked
  create-tenant --name <name>                            a new tenant (needs DESKMATES_TENANCY=multi)
  list-tenants
  set-tenant-policy --tenant <id> --policy <local_or_sso|sso_optional|sso_required>
  set-tenant-status --tenant <id> --status <active|suspended>
  add-member --tenant <id> --login <name> --role <owner|admin|member>
${SERVICE_PRINCIPAL_USAGE}
  add-oidc-provider --id <slug> --name <display> --issuer <url> --client-id <id>
                    --redirect-uri <url> [--scopes "openid email profile"] [--public]
  set-oidc-provider-status --id <slug> --status <active|disabled>
  list-oidc-providers
  link-tenant-sso --tenant <id> --provider <slug> [--jit member] [--max-auth-age <seconds>]
  unlink-tenant-sso --tenant <id> --provider <slug>
  preflight                                              check readiness for DESKMATES_TENANCY=multi
  backup --out <file>                                    consistent copy + manifest (Gateway may run)
  restore --from <file>                                  Gateway stopped; revokes every credential
Passwords and OIDC client secrets are read from stdin.`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function need(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.trim() === "") throw new UsageError(`--${name} is required`);
  return value;
}

class UsageError extends Error {}

function roleOption(args: string[]): TenantRole {
  const role = need(args, "role");
  if (!(TENANT_ROLES as readonly string[]).includes(role))
    throw new UsageError("--role must be owner, admin, member or guest");
  return role as TenantRole;
}

function normalizeLoginNameOrUsage(raw: string): string {
  try {
    return normalizeLoginName(raw);
  } catch {
    throw new UsageError("invalid login name");
  }
}

/**
 * The person a maintenance command names: `--login <x>` or the first positional argument, where
 * x is a user id, a local login name, or the verified email of exactly one person's SSO login
 * (an SSO person has no local login name).
 */
function targetUser(auth: AuthService, args: string[]): User {
  const positional = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : undefined;
  const raw = (option(args, "login") ?? positional)?.trim();
  if (!raw) throw new UsageError("a login name, SSO email or user id is required");
  const byId = auth.users.getUser(raw);
  if (byId) return byId;
  let local: string | undefined;
  try {
    local = auth.users.findLocalLogin(normalizeLoginName(raw))?.userId;
  } catch {
    local = undefined;
  }
  const ids = local ? [local] : auth.users.userIdsByLoginEmail(raw);
  if (ids.length > 1)
    throw new UsageError(`${raw} belongs to ${ids.length} people; name one by user id`);
  const user = ids[0] === undefined ? undefined : auth.users.getUser(ids[0]);
  if (!user) throw new UsageError("no such login name, SSO email or user id");
  return user;
}

async function newPassword(io: CliIo): Promise<string> {
  const first = await io.readPassword("New password: ");
  const second = await io.readPassword("Repeat password: ");
  if (first !== second) throw new UsageError("passwords do not match");
  return first;
}

/** Run one command; returns the process exit code. */
export async function runAuthCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "help") {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  // The Gateway's own rule: GATEWAY_DB relative to the working directory. Name the file it
  // resolved to, and never create one: a missing file means this is not the database the
  // Gateway opened, and an account made there would never let anyone sign in.
  const dbPath = resolve(io.env.GATEWAY_DB?.trim() || "./data/gateway.sqlite");
  if (command === "restore") {
    // Restore is the one command that may create the database file; it never runs on a live one
    // because it moves the current file aside first (stop the Gateway before running it).
    try {
      const from = resolve(need(args, "from"));
      const result = restoreDatabase(from, dbPath);
      io.err(`Gateway database: ${dbPath}`);
      io.out(
        `Restored ${from}. ${result.sessionsRevoked} session(s), ${result.runTokensRevoked} run token(s) and ${result.invitationsRevoked} open invitation(s) revoked, ${result.serviceTokensRevoked} service principal token(s) cleared; everyone signs in again.${result.previous ? ` Previous database kept at ${result.previous}.` : ""}`,
      );
      return 0;
    } catch (err) {
      if (err instanceof UsageError) {
        io.err(err.message);
        return 2;
      }
      if (isDeskmatesError(err)) {
        io.err(err.message);
        return 1;
      }
      throw err;
    }
  }
  if (!existsSync(dbPath)) {
    io.err(
      `No Gateway database at ${dbPath}. Start the Gateway once, or run this from the Gateway's working directory or with GATEWAY_DB set to its database.`,
    );
    return 1;
  }
  io.err(`Gateway database: ${dbPath}`);
  const db = openDatabase(dbPath);
  const auth = new AuthService(db, authConfig(io.env));
  const oidcStore = () => new OidcStore(db, new SecretsStore(db, io.env.GATEWAY_SECRETS_KEY ?? ""));
  try {
    const servicePrincipalExit = runServicePrincipalCommand(command, args, {
      auth,
      option,
      need,
      out: io.out,
    });
    if (servicePrincipalExit !== undefined) return servicePrincipalExit;
    switch (command) {
      case "bootstrap-owner": {
        // The protected root account `admin` with a password the operator types, before first
        // start. Its login is always `admin`: no other name is ever the root (ADR-0022
        // amendment 6 W2).
        if (option(args, "login") !== undefined && option(args, "login") !== PROTECTED_ROOT_LOGIN)
          throw new UsageError(`the root account's login is always "${PROTECTED_ROOT_LOGIN}"`);
        const name = option(args, "name") ?? "Administrator";
        if (!auth.setupRequired()) {
          io.err("An account already exists; bootstrap is closed. Use create-user.");
          return 1;
        }
        const user = await auth.bootstrapRoot({
          loginName: PROTECTED_ROOT_LOGIN,
          displayName: name,
          password: await newPassword(io),
        });
        io.out(
          `Created Owner ${user.id} (${user.displayName}), the protected root account, with login "${PROTECTED_ROOT_LOGIN}".`,
        );
        return 0;
      }
      case "create-root": {
        // The Gateway does this at its first start; the command is for a database prepared
        // before then (ADR-0031 decision 8).
        const user = await auth.ensureProtectedRoot();
        if (!user) {
          io.err(
            "An account already exists; the root account is created only on an empty database.",
          );
          return 1;
        }
        io.out(
          `Created the protected root account ${user.id} with login "admin" and password "admin"; change it at first sign-in.`,
        );
        return 0;
      }
      case "create-user": {
        const role = roleOption(args);
        const tenantId = option(args, "tenant") ?? DEFAULT_TENANT_ID;
        const user = await auth.createUser({
          loginName: need(args, "login"),
          displayName: need(args, "name"),
          role,
          tenantId,
          password: await newPassword(io),
        });
        io.out(`Created ${role} ${user.id} (${user.displayName}) in tenant ${tenantId}.`);
        return 0;
      }
      case "create-tenant": {
        if (parseTenancyMode(io.env.DESKMATES_TENANCY) !== "multi") {
          io.err(
            "This deployment is single-tenant. Run `preflight`, then set DESKMATES_TENANCY=multi before creating a second tenant.",
          );
          return 1;
        }
        const tenant = auth.users.createTenant({ name: need(args, "name") });
        io.out(`Created tenant ${tenant.id} (${tenant.name}).`);
        return 0;
      }
      case "list-tenants": {
        for (const tenant of auth.users.listTenants())
          io.out(
            [
              tenant.id,
              tenant.status,
              `${tenant.authPolicy}@v${tenant.authPolicyVersion}`,
              tenant.name,
            ].join("\t"),
          );
        return 0;
      }
      case "set-tenant-policy": {
        const tenant = auth.users.setTenantPolicy(
          need(args, "tenant"),
          need(args, "policy") as TenantAuthPolicy,
        );
        io.out(
          `Tenant ${tenant.id} policy ${tenant.authPolicy} (version ${tenant.authPolicyVersion}); earlier grants no longer admit.`,
        );
        return 0;
      }
      case "set-tenant-status": {
        const status = need(args, "status");
        if (status !== "active" && status !== "suspended")
          throw new UsageError("--status must be active or suspended");
        const tenant = auth.users.setTenantStatus(need(args, "tenant"), status);
        io.out(`Tenant ${tenant.id} is ${tenant.status}.`);
        return 0;
      }
      case "add-member": {
        const tenantId = need(args, "tenant");
        const login = auth.users.findLocalLogin(normalizeLoginNameOrUsage(need(args, "login")));
        if (!login) throw new UsageError("no such login name");
        const membership = auth.users.addMembership(tenantId, login.userId, roleOption(args));
        io.out(`${login.subject} is ${membership.role} of ${tenantId}.`);
        return 0;
      }
      case "add-oidc-provider": {
        const isPublic = args.includes("--public");
        const secret = isPublic ? undefined : await io.readPassword("Client secret: ");
        if (!isPublic && !secret) throw new UsageError("a client secret is required (or --public)");
        const scopes = option(args, "scopes");
        const provider = oidcStore().addProvider({
          id: need(args, "id"),
          displayName: need(args, "name"),
          issuer: need(args, "issuer"),
          clientId: need(args, "client-id"),
          redirectUri: need(args, "redirect-uri"),
          ...(secret !== undefined ? { clientSecret: secret } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
        });
        io.out(`Added OIDC provider ${provider.id} for issuer ${provider.issuer}.`);
        return 0;
      }
      case "set-oidc-provider-status": {
        const status = need(args, "status");
        if (status !== "active" && status !== "disabled")
          throw new UsageError("--status must be active or disabled");
        const provider = oidcStore().setProviderStatus(need(args, "id"), status);
        io.out(`OIDC provider ${provider.id} is ${provider.status}.`);
        return 0;
      }
      case "list-oidc-providers": {
        for (const provider of oidcStore().listProviders())
          io.out(
            [
              provider.id,
              provider.status,
              provider.issuer,
              provider.clientId,
              provider.clientSecretId === null ? "public" : "confidential",
              provider.redirectUri,
            ].join("\t"),
          );
        return 0;
      }
      case "link-tenant-sso": {
        const jit = option(args, "jit");
        if (jit !== undefined && jit !== "member") throw new UsageError("--jit may only be member");
        const age = option(args, "max-auth-age");
        const link = oidcStore().linkTenant(need(args, "tenant"), need(args, "provider"), {
          jitRole: jit === "member" ? "member" : null,
          ...(age !== undefined ? { maxAuthAgeSeconds: Number(age) } : {}),
        });
        io.out(
          `Tenant ${link.tenantId} trusts ${link.providerId} (max auth age ${link.maxAuthAgeSeconds}s, JIT ${link.jitRole ?? "off"}).`,
        );
        return 0;
      }
      case "preflight": {
        const problems = tenancyPreflight(db, auth.config);
        for (const problem of problems) io.out(`not ready: ${problem}`);
        if (problems.length === 0) io.out("ready for DESKMATES_TENANCY=multi");
        return problems.length === 0 ? 0 : 1;
      }
      case "backup": {
        const out = resolve(need(args, "out"));
        const manifest = await backupDatabase(dbPath, out);
        io.out(
          `Backup written to ${out} (sha256 ${manifest.sha256}); manifest at ${manifestPath(out)}.`,
        );
        return 0;
      }
      case "unlink-tenant-sso": {
        const removed = oidcStore().unlinkTenant(need(args, "tenant"), need(args, "provider"));
        io.out(removed ? "Unlinked; its grants stop admitting now." : "No such link.");
        return 0;
      }
      case "reset-password": {
        const login = need(args, "login");
        const revoked = await auth.resetPassword(login, await newPassword(io));
        io.out(`Password set; ${revoked} session(s) revoked.`);
        return 0;
      }
      case "disable-user":
      case "enable-user": {
        const revoked = auth.setUserDisabled(need(args, "login"), command === "disable-user");
        io.out(
          command === "disable-user"
            ? `User disabled; ${revoked} session(s) revoked.`
            : "User enabled.",
        );
        return 0;
      }
      case "revoke-sessions": {
        io.out(`${auth.revokeSessions(need(args, "login"))} session(s) revoked.`);
        return 0;
      }
      case "list-users": {
        const tenantId = option(args, "tenant") ?? DEFAULT_TENANT_ID;
        for (const user of auth.users.listUsers()) {
          const membership = auth.users.getMembership(tenantId, user.id);
          io.out(
            [
              user.id,
              user.loginName ?? "-",
              user.status,
              membership ? `${membership.role}/${membership.status}` : "no-membership",
              user.displayName,
              ...(user.platformRole === "maintainer" ? ["maintainer"] : []),
            ].join("\t"),
          );
        }
        return 0;
      }
      // Platform maintenance (ADR-0022) stays CLI-only: no HTTP route grants it. The guard reads
      // the user row on every request, so a change applies to open sessions on their next call.
      case "grant-maintainer": {
        const user = targetUser(auth, args);
        if (user.platformRole === "maintainer") {
          io.out(`${user.displayName} (${user.id}) is already a platform maintainer.`);
          return 0;
        }
        auth.users.setPlatformRole(user.id, "maintainer");
        io.out(
          `${user.displayName} (${user.id}) is now a platform maintainer.${user.status === "disabled" ? " The account is disabled; enable it before it can act." : ""}`,
        );
        return 0;
      }
      case "revoke-maintainer": {
        const user = targetUser(auth, args);
        io.out(
          auth.users.revokePlatformMaintainer(user.id)
            ? `${user.displayName} (${user.id}) is no longer a platform maintainer.`
            : `${user.displayName} (${user.id}) is not a platform maintainer; nothing changed.`,
        );
        return 0;
      }
      default:
        io.err(`unknown command: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message);
      return 2;
    }
    if (isDeskmatesError(err)) {
      io.err(err.message);
      return 1;
    }
    throw err;
  } finally {
    auth.live.stop();
    db.close();
  }
}

/** stdin line reader that hides typed characters on a terminal. */
function terminalIo(): CliIo {
  const piped = !process.stdin.isTTY;
  let lines: AsyncIterator<string> | undefined;
  return {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    async readPassword(prompt) {
      if (piped) {
        lines ??= createInterface({ input: process.stdin, terminal: false })[
          Symbol.asyncIterator
        ]();
        const next = await lines.next();
        if (next.done) throw new UsageError("no password on stdin");
        return next.value;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      // Replace echoed characters: readline writes through _writeToOutput.
      const internal = rl as unknown as { _writeToOutput: (s: string) => void };
      let prompted = false;
      internal._writeToOutput = (s: string) => {
        if (!prompted) {
          process.stdout.write(s);
          prompted = true;
        }
      };
      const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
      rl.close();
      process.stdout.write("\n");
      return answer;
    },
  };
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  runAuthCli(process.argv.slice(2), terminalIo()).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
