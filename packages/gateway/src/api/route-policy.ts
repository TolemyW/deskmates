// The operator route manifest (ADR-0022 P2 coverage manifest) and the guard that enforces it.
//
// Every `/api/*` route has exactly one entry; `route-policy.test.ts` fails when a route is added
// without one or an entry names no route. An entry says who may call the route and which
// identifiers in it name tenant-owned rows. Before any handler runs, the guard checks the
// caller's role and resolves every declared identifier to its tenant in SQL; anything that is
// missing or belongs to another tenant is the same uniform 404. Routes marked `scopedList`
// return collections and filter them by the caller's tenant in their own SQL.
//
// Entries live in one file per domain under `route-policies/` (issue #53); this file is the one
// audited aggregation point. A new domain adds one line to the sorted list below.

import { DeskmatesError, type TenantRole, workspaceRoleAtLeast } from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Principal } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import type { OwnedKind } from "../tenancy/ownership.js";
import { analyticsRoutePolicies } from "./route-policies/analytics.js";
import { appSharesRoutePolicies } from "./route-policies/app-shares.js";
import { approvalsRoutePolicies } from "./route-policies/approvals.js";
import { boardRoutePolicies } from "./route-policies/board.js";
import { botConfigRoutePolicies } from "./route-policies/bot-config.js";
import { botsRoutePolicies } from "./route-policies/bots.js";
import { browserRoutePolicies } from "./route-policies/browser.js";
import { channelsRoutePolicies } from "./route-policies/channels.js";
import { costsRoutePolicies } from "./route-policies/costs.js";
import { desktopToolsRoutePolicies } from "./route-policies/desktop-tools.js";
import { filesRoutePolicies } from "./route-policies/files.js";
import { hostResourcesRoutePolicies } from "./route-policies/host-resources.js";
import { installationRoutePolicies } from "./route-policies/installation.js";
import { integrationsRoutePolicies } from "./route-policies/integrations.js";
import { knowledgeRoutePolicies } from "./route-policies/knowledge.js";
import { limitsRoutePolicies } from "./route-policies/limits.js";
import { membersRoutePolicies } from "./route-policies/members.js";
import { memoryRoutePolicies } from "./route-policies/memory.js";
import { modelJobsRoutePolicies } from "./route-policies/model-jobs.js";
import { networkRoutePolicies } from "./route-policies/network.js";
import { observabilityRoutePolicies } from "./route-policies/observability.js";
import type { PolicyTable, RoutePolicy } from "./route-policies/policy.js";
import { profileRoutePolicies } from "./route-policies/profile.js";
import { runStatsRoutePolicies } from "./route-policies/run-stats.js";
import { runsRoutePolicies } from "./route-policies/runs.js";
import { skillsRoutePolicies } from "./route-policies/skills.js";
import { taskKindsRoutePolicies } from "./route-policies/task-kinds.js";
import { tasksRoutePolicies } from "./route-policies/tasks.js";
import { threadsRoutePolicies } from "./route-policies/threads.js";
import { vaultRoutePolicies } from "./route-policies/vault.js";
import { webSearchRoutePolicies } from "./route-policies/web-search.js";
import { workdirRoutePolicies } from "./route-policies/workdir.js";
import { workspacesRoutePolicies } from "./route-policies/workspaces.js";
import { isRootPrincipal, workspaceRole } from "./workspace-access.js";

export type { RoutePolicy } from "./route-policies/policy.js";

/**
 * The domain files, by file name under `route-policies/`, sorted; `route-policy.test.ts` checks
 * the order and that every domain file is listed exactly once.
 */
export const ROUTE_POLICY_DOMAINS: ReadonlyArray<readonly [domain: string, PolicyTable]> = [
  ["analytics", analyticsRoutePolicies],
  ["app-shares", appSharesRoutePolicies],
  ["approvals", approvalsRoutePolicies],
  ["board", boardRoutePolicies],
  ["bot-config", botConfigRoutePolicies],
  ["bots", botsRoutePolicies],
  ["browser", browserRoutePolicies],
  ["channels", channelsRoutePolicies],
  ["costs", costsRoutePolicies],
  ["desktop-tools", desktopToolsRoutePolicies],
  ["files", filesRoutePolicies],
  ["host-resources", hostResourcesRoutePolicies],
  ["installation", installationRoutePolicies],
  ["integrations", integrationsRoutePolicies],
  ["knowledge", knowledgeRoutePolicies],
  ["limits", limitsRoutePolicies],
  ["members", membersRoutePolicies],
  ["memory", memoryRoutePolicies],
  ["model-jobs", modelJobsRoutePolicies],
  ["network", networkRoutePolicies],
  ["observability", observabilityRoutePolicies],
  ["profile", profileRoutePolicies],
  ["run-stats", runStatsRoutePolicies],
  ["runs", runsRoutePolicies],
  ["skills", skillsRoutePolicies],
  ["task-kinds", taskKindsRoutePolicies],
  ["tasks", tasksRoutePolicies],
  ["threads", threadsRoutePolicies],
  ["vault", vaultRoutePolicies],
  ["web-search", webSearchRoutePolicies],
  ["workdir", workdirRoutePolicies],
  ["workspaces", workspacesRoutePolicies],
];

/** Merge domain tables into one; a route claimed by two domains is a startup error. */
export function mergeRoutePolicies(
  domains: ReadonlyArray<readonly [domain: string, PolicyTable]>,
): Readonly<Record<string, RoutePolicy>> {
  const merged: Record<string, RoutePolicy> = {};
  const owner = new Map<string, string>();
  for (const [domain, table] of domains)
    for (const [key, policy] of Object.entries(table)) {
      const previous = owner.get(key);
      if (previous !== undefined)
        throw new Error(`route policy ${key} is declared by both ${previous} and ${domain}`);
      owner.set(key, domain);
      merged[key] = policy;
    }
  return merged;
}

/**
 * Role choices follow ADR-0022 amendment 6, four roles per workspace: Owners and Admins own the
 * group (its chats, thread members, tasks, memory, configuration, persistent approval answers);
 * Members read the workspace, post in its shared chats and their own private chats, execute
 * tasks, stop the runs they started and answer their approvals once; Guests read the shared
 * chats and the board, post on the board and open private inquiries. A private chat is its
 * person's alone, whatever anyone's role. Platform maintenance keeps the runtime, prices,
 * provider adoption and action overrides; the root alone manages service principals. A service
 * principal is checked like a person of its machine role, `admin` or `member` (amendment 1 A10).
 */
export const ROUTE_POLICY: Readonly<Record<string, RoutePolicy>> =
  mergeRoutePolicies(ROUTE_POLICY_DOMAINS);

export function roleAtLeast(role: TenantRole, minimum: TenantRole): boolean {
  return workspaceRoleAtLeast(role, minimum);
}

/** Whether the principal may use installation-wide maintenance routes. */
export function isPlatformPrincipal(
  ctx: GatewayContext,
  principal: Principal | undefined,
): boolean {
  if (!principal) return false;
  if (principal.kind === "operator_token") return true;
  // A service principal is a tenant's machine client, never platform maintenance.
  if (principal.kind === "service") return false;
  return ctx.auth.users.getUser(principal.userId)?.platformRole === "maintainer";
}

/** The tenant the request acts in. Every tenant route reads it from here, never from input. */
export function requestTenant(request: FastifyRequest): string {
  const principal = request.principal;
  if (!principal) throw new DeskmatesError("token_rejected", "not signed in");
  return principal.tenantId;
}

/**
 * The caller's tenant role; the operator credential acts as the Default Tenant's Owner and a
 * service principal with its own role, `admin` or `member`.
 */
export function requestRole(request: FastifyRequest): TenantRole {
  const principal = request.principal;
  if (!principal) throw new DeskmatesError("token_rejected", "not signed in");
  return principal.kind === "operator_token" ? "owner" : principal.role;
}

function policyKey(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? ""}`;
}

/**
 * The identifiers a declared field carries. Anything else in it (a repeated query key, which
 * arrives as an array, or a number or object in a body) is refused here: a handler must never
 * receive an id the guard did not resolve.
 */
function ids(value: unknown, many: boolean): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (many) {
    if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      return value.filter((item) => item !== "");
  } else if (typeof value === "string") return [value];
  throw new DeskmatesError(
    "validation",
    many ? "identifiers must be strings" : "identifier must be a string",
  );
}

/**
 * Install after the operator authentication hook in the same scope. A route with no entry is
 * refused outright, so a route added without a policy fails closed even before its test fails.
 */
export function registerRoutePolicy(app: FastifyInstance, ctx: GatewayContext): void {
  app.addHook("preHandler", async (request) => {
    const policy = ROUTE_POLICY[policyKey(request)];
    if (!policy) throw new DeskmatesError("forbidden", "route has no access policy");
    const principal = request.principal;
    if (policy.access === "authenticated") return;
    if (policy.access === "platform") {
      if (!isPlatformPrincipal(ctx, principal))
        throw new DeskmatesError("forbidden", "platform maintenance only");
      return;
    }
    if (policy.access === "root" || policy.access === "root_session") {
      // `root_session` is the protected account's own session: no bearer passes, the operator
      // credential included (ADR-0046 amendment 1 decision 13).
      const bearer = policy.access === "root_session" && principal?.kind !== "user";
      if (bearer || !isRootPrincipal(ctx, principal))
        throw new DeskmatesError("forbidden", "only the administrator account may do this", {
          reason: "root_only",
        });
      ctx.quotas.takeRequest(requestTenant(request));
      return;
    }
    const tenantId = requestTenant(request);
    // The stream is one long request; every other call spends the tenant's request budget.
    if (policyKey(request) !== "GET /api/events") ctx.quotas.takeRequest(tenantId);
    if (!roleAtLeast(requestRole(request), policy.role))
      throw new DeskmatesError("forbidden", `requires the ${policy.role} role in this tenant`);
    // Roles are per workspace (ADR-0022 amendment 6 W1): a person needs the role in the row's
    // workspace, and one they do not belong to is the uniform 404 (see `workspaceRole`).
    const userId = principal?.kind === "user" ? principal.userId : undefined;
    const check = (kind: OwnedKind, id: string) => {
      ctx.ownership.require(tenantId, kind, id);
      const workspaceId = ctx.ownership.workspaceOf(kind, id);
      const role = workspaceId === undefined ? undefined : workspaceRole(ctx, request, workspaceId);
      if (userId !== undefined && workspaceId !== undefined) {
        if (role === undefined) throw new DeskmatesError("not_found", "Not found");
        if (!roleAtLeast(role, policy.role))
          throw new DeskmatesError(
            "forbidden",
            `requires the ${policy.role} role in this workspace`,
            { reason: "workspace_role" },
          );
      }
      // A private chat and everything hanging off it is its person's alone, whatever anyone's
      // role (W7); a Guest reads no bus thread (W6). Both are the uniform 404.
      const conversation = ctx.ownership.conversationOf(kind, id);
      if (conversation === undefined) return;
      if (conversation.privateTo !== null && conversation.privateTo !== userId)
        throw new DeskmatesError("not_found", "Not found");
      if (conversation.kind === "bus" && role === "guest")
        throw new DeskmatesError("not_found", "Not found");
    };
    const params = (request.params ?? {}) as Record<string, unknown>;
    for (const [name, kind] of Object.entries(policy.params ?? {}))
      for (const id of ids(params[name], false)) check(kind, id);
    const query = (request.query ?? {}) as Record<string, unknown>;
    for (const [name, kind] of Object.entries(policy.query ?? {}))
      for (const id of ids(query[name], false)) check(kind, id);
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    for (const [name, ref] of Object.entries(policy.body ?? {})) {
      const many = ref.endsWith("[]");
      const kind = (many ? ref.slice(0, -2) : ref) as OwnedKind;
      for (const id of ids(body[name], many)) check(kind, id);
    }
  });
}
