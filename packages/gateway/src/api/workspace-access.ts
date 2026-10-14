// Who may read and act in which workspace (ADR-0022 amendment 6): the caller's role in one
// workspace, the workspaces a list may show them, and the private-audience filter for threads,
// runs and approvals. The route guard in `route-policy.ts` and the list handlers use these.

import { type TenantRole, workspaceRoleAtLeast } from "@deskmates/contracts";
import type { FastifyRequest } from "fastify";
import type { Principal } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";

const roleAtLeast = workspaceRoleAtLeast;

/**
 * The caller's role in one workspace (ADR-0022 amendment 6 W1): the operator credential and the
 * protected account are Owners of every workspace, a service principal holds its machine role
 * across its tenant, a person their membership's role there. Undefined: no role there.
 */
export function workspaceRole(
  ctx: GatewayContext,
  request: FastifyRequest,
  workspaceId: string,
): TenantRole | undefined {
  const principal = request.principal;
  if (!principal) return undefined;
  if (principal.kind === "operator_token") return "owner";
  if (principal.kind === "service") return principal.role;
  return ctx.auth.roleInWorkspace({ userId: principal.userId }, workspaceId);
}

/**
 * Whether the caller acts below Admin in `workspaceId`: a Member or Guest, or a `member` service
 * principal. That is the principal amendment 1 and amendment 6 W5 and W6 limit to their own
 * chats, their own runs and one-time approval answers.
 */
export function actsBelowAdmin(
  ctx: GatewayContext,
  request: FastifyRequest,
  workspaceId: string,
): boolean {
  const role = workspaceRole(ctx, request, workspaceId);
  return role === undefined || !roleAtLeast(role, "admin");
}

/**
 * The workspaces whose rows a list may show the caller: those where they hold at least
 * `minimum` (ADR-0022 amendment 6 W1). Undefined means every workspace of the tenant: the
 * operator credential, a service principal and the protected account.
 */
export function readableWorkspaceIds(
  ctx: GatewayContext,
  request: FastifyRequest,
  minimum: TenantRole,
): Set<string> | undefined {
  const principal = request.principal;
  if (!principal || principal.kind !== "user") return undefined;
  if (ctx.auth.users.isProtected(principal.userId)) return undefined;
  return new Set(
    ctx.auth.memberships
      .listForUser(principal.userId)
      .filter((m) => roleAtLeast(m.role, minimum))
      .map((m) => m.workspaceId),
  );
}

/**
 * Keep only the threads, runs or approvals a list may show the caller (W1, W6, W7): in a
 * workspace where they hold at least `minimum`, not in another person's private chat, and for a
 * Guest no bus thread. One lookup per row; lists are paged or small.
 */
export function visibleOfKind<T extends { id: string }>(
  ctx: GatewayContext,
  request: FastifyRequest,
  kind: "thread" | "run" | "approval",
  rows: T[],
  minimum: TenantRole = "member",
): T[] {
  const principal = request.principal;
  const userId = principal?.kind === "user" ? principal.userId : undefined;
  const roles = new Map<string, TenantRole | undefined>();
  const roleIn = (workspaceId: string) => {
    if (!roles.has(workspaceId)) roles.set(workspaceId, workspaceRole(ctx, request, workspaceId));
    return roles.get(workspaceId);
  };
  return rows.filter((row) => {
    const workspaceId = ctx.ownership.workspaceOf(kind, row.id);
    if (workspaceId === undefined) return false;
    const role = roleIn(workspaceId);
    if (role === undefined || !roleAtLeast(role, minimum)) return false;
    const conversation = ctx.ownership.conversationOf(kind, row.id);
    if (conversation === undefined) return true;
    if (conversation.privateTo !== null && conversation.privateTo !== userId) return false;
    return !(conversation.kind === "bus" && role === "guest");
  });
}

/** Whether the request comes from the root: the operator credential or the protected account. */
export function isRootPrincipal(ctx: GatewayContext, principal: Principal | undefined): boolean {
  if (principal?.kind === "operator_token") return true;
  return principal?.kind === "user" && ctx.auth.users.isProtected(principal.userId);
}
