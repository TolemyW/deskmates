// Maintenance CLI commands for service principals (ADR-0022 amendment 2), the platform-side
// equivalent of the tenant Admin routes. Kept apart from `cli.ts` so the command table there only
// gains one dispatch line. A token is printed once, on stdout, and is never stored in clear.
//
//   auth-cli create-service-principal --tenant tnt_default --name release-agent \
//     [--role admin|member] [--daily-usd-cap 5]
//   auth-cli list-service-principals [--tenant <id>]
//   auth-cli disable-service-principal --id svc_...
//   auth-cli rotate-service-principal --id svc_...

import { DeskmatesError } from "@deskmates/contracts";
import type { AuthService } from "./auth-service.js";

export const SERVICE_PRINCIPAL_USAGE = `  create-service-principal --tenant <id> --name <name> [--role admin|member]
                    [--daily-usd-cap <usd>]
                                                         a tenant's machine identity (member by
                                                         default); prints its token once
  list-service-principals [--tenant <id>]
  disable-service-principal --id <id>                    for good; its token stops working at once
  rotate-service-principal --id <id>                     new token, printed once; the old one stops`;

/** The argument and output helpers `cli.ts` already has, passed in so behaviour is identical. */
export interface ServicePrincipalCliDeps {
  auth: AuthService;
  option(args: string[], name: string): string | undefined;
  need(args: string[], name: string): string;
  out(line: string): void;
}

/** Who the ledger names for a maintenance action. */
const CLI_ACTOR = "platform:cli";

function numberOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  // Anything non-numeric becomes NaN, which the store's validation refuses by field name.
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : Number.NaN;
}

/**
 * Run `command` if it is a service principal command and return its exit code; return undefined
 * for any other command. Errors propagate to `cli.ts`, which maps them to exit codes.
 */
export function runServicePrincipalCommand(
  command: string,
  args: string[],
  deps: ServicePrincipalCliDeps,
): number | undefined {
  const { auth, option, need, out } = deps;
  const mustFind = (id: string) => {
    const record = auth.servicePrincipals.getAnyTenant(id);
    if (!record) throw new DeskmatesError("not_found", "no such service principal");
    return record;
  };
  switch (command) {
    case "create-service-principal": {
      const tenantId = need(args, "tenant");
      const { record, token } = auth.servicePrincipals.create(
        tenantId,
        {
          name: need(args, "name"),
          // Platform maintenance names the role; without --role a principal is a Member, the
          // narrower choice (ADR-0022 amendment 1 A10). Never an Owner.
          role: option(args, "role") ?? "member",
          dailyUsdCap: numberOption(option(args, "daily-usd-cap")),
        },
        CLI_ACTOR,
        "admin",
      );
      out(
        `Created service principal ${record.id} (${record.name}) as ${record.role} of ${record.tenantId}; USD ${record.dailyUsdCap} per day.`,
      );
      out(`Token (shown once): ${token}`);
      return 0;
    }
    case "list-service-principals": {
      const tenantId = option(args, "tenant");
      for (const record of auth.servicePrincipals.list(tenantId))
        out(
          [
            record.id,
            record.tenantId,
            record.role,
            record.status,
            record.tokenIssuedAt === null ? "no-token" : `token@${record.tokenIssuedAt}`,
            `usd/day<=${record.dailyUsdCap}`,
            record.name,
          ].join("\t"),
        );
      return 0;
    }
    case "disable-service-principal": {
      const record = mustFind(need(args, "id"));
      auth.disableServicePrincipal(record.tenantId, record.id, CLI_ACTOR);
      out(`Service principal ${record.id} is disabled; its token no longer works.`);
      return 0;
    }
    case "rotate-service-principal": {
      const record = mustFind(need(args, "id"));
      const { token } = auth.rotateServicePrincipal(record.tenantId, record.id);
      out(`Service principal ${record.id} has a new token; the previous one no longer works.`);
      out(`Token (shown once): ${token}`);
      return 0;
    }
    default:
      return undefined;
  }
}
