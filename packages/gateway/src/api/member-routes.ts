// Workspace membership and invitations (ADR-0022 P4, amendment 6 W3, W4, W9). Every route acts
// in the request's tenant and in one workspace of it (`workspaceId`, or the tenant's only one): a
// user id or invitation id of another tenant is the same uniform 404 as a missing one.

import {
  type CreatedAccountView,
  type CreatedInvitationView,
  DeskmatesError,
  type InvitationView,
  type InvitationsPage,
  type MembersPage,
  PAGE_LIMIT_MAX,
  PEOPLE_PAGE_SIZE,
  type PageLimitPolicy,
  TENANT_ROLES,
  type TenantRole,
  isInvitableRole,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Invitation, InvitationRole, InvitationTarget } from "../auth/invitations.js";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { requestActorId } from "./actor.js";
import { invitationTarget } from "./auth-routes.js";
import { parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";

/**
 * People are managed by people (ADR-0022 amendment 1 A13): members, invitations and created
 * accounts are refused to every service principal, whatever its role. A principal has no user
 * to attribute the change to or to check the last-Owner and invitation rules against. The
 * operator credential keeps its Owner rights in the Default Tenant (C8).
 */
function requirePerson(request: FastifyRequest): void {
  if (request.principal?.kind === "service")
    throw new DeskmatesError("forbidden", "people are managed by people, not service principals", {
      reason: "people_only",
    });
}

/** People pages (#113 slice M): 25 by default, at most 100; a larger limit is refused. */
export const PEOPLE_PAGE: PageLimitPolicy = { default: PEOPLE_PAGE_SIZE, max: PAGE_LIMIT_MAX };

function actorOf(request: FastifyRequest): { userId: string | null; label: string } {
  const principal = request.principal;
  // The operator credential (no user) acts as Owner of every Default Tenant workspace.
  return {
    userId: principal?.kind === "user" ? principal.userId : null,
    label: actorLabel(principal),
  };
}

/**
 * The workspace a people change applies to (ADR-0031 decision 7): the one named, which must be
 * the tenant's, or the tenant's only active workspace. With several and none named the request
 * is refused rather than guessed.
 */
function selectedWorkspace(ctx: GatewayContext, tenantId: string, raw: unknown): string {
  if (raw !== undefined) {
    if (typeof raw !== "string" || ctx.ownership.tenantOf("workspace", raw) !== tenantId)
      throw new DeskmatesError("not_found", "workspace not found");
    return raw;
  }
  const active = ctx.workspaces.list(tenantId);
  if (active.length !== 1 || !active[0])
    throw new DeskmatesError("validation", "workspaceId is required: roles are per workspace", {
      reason: "workspace_required",
    });
  return active[0].id;
}

/** People of a workspace are managed by its Owners and Admins (W4); others are refused. */
function requireManager(ctx: GatewayContext, request: FastifyRequest, workspaceId: string): void {
  const role = ctx.auth.roleInWorkspace(actorOf(request), workspaceId);
  if (role === undefined) throw new DeskmatesError("not_found", "workspace not found");
  if (role !== "owner" && role !== "admin")
    throw new DeskmatesError("forbidden", "requires the admin role in this workspace", {
      reason: "workspace_role",
    });
}

function invitationView(invitation: Invitation, now: Date): InvitationView {
  return {
    id: invitation.id,
    role: invitation.role,
    workspaceId: invitation.workspaceId,
    target: invitationTarget(invitation),
    createdBy: invitation.createdBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    status: invitation.consumedAt
      ? "accepted"
      : invitation.revokedAt
        ? "revoked"
        : Date.parse(invitation.expiresAt) <= now.getTime()
          ? "expired"
          : "open",
  };
}

function parseTarget(raw: unknown): InvitationTarget {
  const target = asRecord(raw);
  const kind = target.kind;
  const text = (key: string): string => {
    const value = target[key];
    if (typeof value !== "string" || value.trim() === "")
      throw new DeskmatesError("validation", `target.${key} is required`);
    return value;
  };
  if (kind === "local_signup") return { kind };
  if (kind === "local_new" || kind === "local_user") return { kind, loginName: text("loginName") };
  if (kind === "oidc_email") return { kind, providerId: text("providerId"), email: text("email") };
  throw new DeskmatesError(
    "validation",
    "target.kind must be local_signup, local_new, local_user or oidc_email",
  );
}

export function registerMemberRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const auth = ctx.auth;

  app.get<{
    Querystring: {
      workspaceId?: string;
      role?: string;
      status?: string;
      offset?: string;
      limit?: string;
    };
  }>("/api/members", async (request): Promise<MembersPage> => {
    requirePerson(request);
    const tenantId = requestTenant(request);
    const workspaceId = selectedWorkspace(ctx, tenantId, request.query.workspaceId);
    requireManager(ctx, request, workspaceId);
    const { offset, limit } = parseOffsetQuery(request.query, PEOPLE_PAGE);
    const { role, status } = request.query;
    if (role !== undefined && !(TENANT_ROLES as readonly unknown[]).includes(role))
      throw new DeskmatesError("validation", "role must be owner, admin, member or guest", {
        field: "role",
      });
    if (status !== undefined && status !== "active" && status !== "removed")
      throw new DeskmatesError("validation", "status must be active or removed", {
        field: "status",
      });
    const page = auth.pageWorkspaceMembers(tenantId, workspaceId, {
      offset,
      limit,
      ...(role !== undefined ? { role: role as TenantRole } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    return { members: page.members, offset, limit, total: page.total };
  });

  app.patch<{ Params: { userId: string } }>("/api/members/:userId", async (request) => {
    requirePerson(request);
    const body = asRecord(request.body);
    const change: { role?: TenantRole; status?: "active" | "removed"; workspaceId?: string } = {};
    if (body.role !== undefined) {
      if (!(TENANT_ROLES as readonly unknown[]).includes(body.role))
        throw new DeskmatesError("validation", "role must be owner, admin, member or guest");
      change.role = body.role as TenantRole;
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "removed")
        throw new DeskmatesError("validation", "status must be active or removed");
      change.status = body.status;
    }
    if (change.role === undefined && change.status === undefined)
      throw new DeskmatesError("validation", "nothing to change");
    const tenantId = requestTenant(request);
    // A role is a role in one workspace; a removal names its workspace too (W9). Only leaving
    // the tenant oneself takes no workspace.
    const leaving =
      change.role === undefined &&
      change.status === "removed" &&
      body.workspaceId === undefined &&
      request.principal?.kind === "user" &&
      request.principal.userId === request.params.userId;
    if (!leaving) change.workspaceId = selectedWorkspace(ctx, tenantId, body.workspaceId);
    auth.changeMembership(actorOf(request), tenantId, request.params.userId, change);
    const members =
      change.workspaceId === undefined
        ? auth.listMembers(tenantId)
        : auth.listWorkspaceMembers(tenantId, change.workspaceId);
    return { member: members.find((m) => m.userId === request.params.userId) };
  });

  app.get<{ Querystring: { workspaceId?: string; offset?: string; limit?: string } }>(
    "/api/invitations",
    async (request): Promise<InvitationsPage> => {
      requirePerson(request);
      const tenantId = requestTenant(request);
      const workspaceId = selectedWorkspace(ctx, tenantId, request.query.workspaceId);
      requireManager(ctx, request, workspaceId);
      const { offset, limit } = parseOffsetQuery(request.query, PEOPLE_PAGE);
      const now = new Date();
      const page = auth.invitations.pageForWorkspace(tenantId, workspaceId, { offset, limit });
      return {
        invitations: page.invitations.map((invitation) => invitationView(invitation, now)),
        offset,
        limit,
        total: page.total,
      };
    },
  );

  app.post("/api/invitations", async (request, reply) => {
    requirePerson(request);
    const body = asRecord(request.body);
    const tenantId = requestTenant(request);
    const role = body.role;
    if (!isInvitableRole(role))
      throw new DeskmatesError("validation", "role must be admin, member or guest");
    // Into one workspace, by its Owner or Admin, as Admin, Member or Guest (amendment 6 W4).
    const workspaceId = selectedWorkspace(ctx, tenantId, body.workspaceId);
    requireManager(ctx, request, workspaceId);
    const target = parseTarget(body.target);
    if (target.kind === "oidc_email" && !ctx.oidc.store.tenantLink(tenantId, target.providerId))
      throw new DeskmatesError("validation", "that provider is not one this tenant trusts");
    const expires = body.expiresInSeconds;
    if (expires !== undefined && typeof expires !== "number")
      throw new DeskmatesError("validation", "expiresInSeconds must be a number");
    const created = auth.createInvitation(tenantId, {
      workspaceId,
      role: role as InvitationRole,
      target,
      createdBy: requestActorId(request, body),
      ...(expires !== undefined ? { ttlSeconds: expires } : {}),
    });
    const view: CreatedInvitationView = {
      invitation: invitationView(created.invitation, new Date()),
      link: `/#/invite/${created.token}`,
    };
    return reply.code(201).send(view);
  });

  // An Admin creates a local account with a generated initial password (ADR-0022 amendment 4
  // I4). The password is in this one response only: never stored in clear, logged or listed.
  app.post("/api/accounts", async (request, reply) => {
    requirePerson(request);
    reply.header("cache-control", "no-store");
    const body = asRecord(request.body);
    const tenantId = requestTenant(request);
    const workspaceId = selectedWorkspace(ctx, tenantId, body.workspaceId);
    const created = await auth.createAccount(actorOf(request), tenantId, {
      loginName: body.loginName,
      displayName: body.displayName,
      role: body.role,
      workspaceId,
    });
    const member = auth
      .listWorkspaceMembers(tenantId, workspaceId)
      .find((m) => m.userId === created.user.id);
    if (!member) throw new DeskmatesError("not_found", "Not found");
    const view: CreatedAccountView = {
      member,
      loginName: created.loginName,
      initialPassword: created.initialPassword,
    };
    return reply.code(201).send(view);
  });

  app.delete<{ Params: { id: string } }>("/api/invitations/:id", async (request) => {
    requirePerson(request);
    const tenantId = requestTenant(request);
    const invitation = auth.invitations.get(tenantId, request.params.id);
    if (!invitation) throw new DeskmatesError("not_found", "Not found");
    requireManager(ctx, request, invitation.workspaceId);
    return {
      revoked: auth.invitations.revoke(tenantId, request.params.id, actorLabel(request.principal)),
    };
  });
}
