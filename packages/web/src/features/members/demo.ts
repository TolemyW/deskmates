// Demo routes of the Members page (issue #25): the tenant's people, invitations by link and
// created accounts. Demo data only; nothing here is a real account.

import {
  type InvitationView,
  PEOPLE_PAGE_SIZE,
  type TenantMemberView,
  isInvitableRole,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const store = (s: DemoState) =>
  s.store("members", () => ({
    invitations: [] as InvitationView[],
    invitationSeq: 0,
    tenantMembers: [
      {
        userId: "usr_demo",
        displayName: "Demo operator",
        loginName: "demo",
        role: "owner",
        status: "active",
      },
      {
        userId: "usr_alex",
        displayName: "Alex Chen",
        loginName: "alex",
        role: "admin",
        status: "active",
      },
      {
        userId: "usr_maya",
        displayName: "Maya Patel",
        loginName: "maya",
        role: "member",
        status: "active",
      },
      {
        userId: "usr_sam",
        displayName: "Sam Rivera",
        loginName: "sam",
        role: "member",
        status: "removed",
      },
    ] as TenantMemberView[],
  }));

export const demo: DemoFeature = { route };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, body: b } = req;
  const st = store(s);
  let x: RegExpMatchArray | null;
  // Offset pages like the Gateway's (#113 slice M): 25 by default, filtered by role and status.
  const pageOf = <T>(rows: readonly T[]) => {
    const offset = Number(req.query.get("offset") ?? 0) || 0;
    const limit = Number(req.query.get("limit") ?? PEOPLE_PAGE_SIZE) || PEOPLE_PAGE_SIZE;
    return { rows: rows.slice(offset, offset + limit), offset, limit, total: rows.length };
  };
  if (method === "GET" && path === "/api/members") {
    const role = req.query.get("role");
    const status = req.query.get("status");
    const page = pageOf(
      st.tenantMembers.filter(
        (m) => (role === null || m.role === role) && (status === null || m.status === status),
      ),
    );
    return ok({ members: page.rows, offset: page.offset, limit: page.limit, total: page.total });
  }
  if (method === "GET" && path === "/api/invitations") {
    const page = pageOf(st.invitations);
    return ok({
      invitations: page.rows,
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    });
  }
  // Invite by link and Create account (issue #25); demo data only, no real account.
  if (method === "POST" && path === "/api/invitations") {
    const target = (b.target ?? {}) as { kind?: string; email?: string; providerId?: string };
    if (!isInvitableRole(b.role))
      return { status: 400, json: { code: "validation", message: "Unknown role.", details: {} } };
    st.invitationSeq += 1;
    const id = `inv_demo_${st.invitationSeq}`;
    const invitation: InvitationView = {
      id,
      role: b.role,
      target:
        target.kind === "oidc_email"
          ? { kind: "oidc_email", providerId: target.providerId ?? "", email: target.email ?? "" }
          : { kind: "local_signup" },
      createdBy: "user:usr_demo",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      status: "open",
    };
    st.invitations.unshift(invitation);
    return { status: 201, json: { invitation, link: "/#/invite/demo-signup" } };
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if (method === "DELETE" && (x = req.match(/^\/api\/invitations\/([^/]+)$/))) {
    const invitation = st.invitations.find((item) => item.id === decodeURIComponent(x?.[1] ?? ""));
    if (!invitation) return notFound("invitation");
    const revoked = invitation.status === "open";
    if (revoked) invitation.status = "revoked";
    return ok({ revoked });
  }
  if (method === "POST" && path === "/api/accounts") {
    const loginName = typeof b.loginName === "string" ? b.loginName.trim().toLowerCase() : "";
    const displayName =
      typeof b.displayName === "string" && b.displayName.trim() ? b.displayName.trim() : loginName;
    if (!/^[a-z0-9][a-z0-9._@+-]{0,127}$/.test(loginName))
      return {
        status: 400,
        json: {
          code: "validation",
          message: "Check the username.",
          details: {},
        },
      };
    if (!isInvitableRole(b.role))
      return { status: 400, json: { code: "validation", message: "Unknown role.", details: {} } };
    if (st.tenantMembers.some((item) => item.loginName === loginName))
      return {
        status: 409,
        json: {
          code: "invalid_transition",
          message: "That username is already taken",
          details: { reason: "login_name_taken" },
        },
      };
    const member: TenantMemberView = {
      userId: `usr_${loginName.replace(/[^a-z0-9]/g, "")}`,
      displayName,
      loginName,
      role: b.role,
      status: "active",
    };
    st.tenantMembers.push(member);
    // A fixed demo value, so screenshots are reproducible; the Gateway generates a random one.
    return {
      status: 201,
      json: { member, loginName, initialPassword: "Demo-Pass-Word-Only-Here" },
    };
  }
  if (method === "PATCH" && path.startsWith("/api/members/")) {
    const member = st.tenantMembers.find(
      (item) => item.userId === decodeURIComponent(path.slice("/api/members/".length)),
    );
    if (!member) return notFound("member");
    const invalid = (message: string): Result => ({
      status: 400,
      json: { code: "invalid", message, details: {} },
    });
    if (b.role !== undefined && b.role !== "owner" && !isInvitableRole(b.role))
      return invalid("Unknown role.");
    if (b.status !== undefined && b.status !== "removed")
      return invalid("Only removal is supported.");
    if (
      member.role === "owner" &&
      member.status === "active" &&
      (b.status === "removed" || (b.role !== undefined && b.role !== "owner")) &&
      st.tenantMembers.filter((item) => item.role === "owner" && item.status === "active")
        .length === 1
    )
      return invalid("The last owner must stay.");
    if (b.role !== undefined) member.role = b.role;
    if (b.status === "removed") member.status = "removed";
    return { status: 204 };
  }
  return undefined;
}
