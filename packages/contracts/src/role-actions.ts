// What a session's role may do, for the Web UI to hide or disable what it cannot (issue #14).
// The Gateway's route policy decides; this table names, for each action a screen offers, the
// route that performs it and the role that route requires, so a screen can say in advance which
// role can. `role-actions.test.ts` in the Gateway fails when an entry and the route policy
// disagree. A role here is never a permission: a screen that ignores it is still refused.
//
// Roles are per workspace (ADR-0022 amendment 6): a screen asks with the workspace it shows.

import { type TenantRole, WORKSPACE_ROLES } from "./auth.js";

/**
 * A workspace role, installation-wide platform maintenance (ADR-0022), or the protected root
 * account alone (amendment 6 W2).
 */
export type ActionRole = TenantRole | "platform" | "root";

export interface RoleActionRule {
  /** `METHOD /api/path` exactly as the Gateway's route policy keys it. */
  route: string;
  role: ActionRole;
  /**
   * Set when the role is stricter than the route's own: the handler refuses the rest. Names the
   * check so a reviewer can find it.
   */
  handlerCheck?: string;
  /**
   * `any`: the role is the highest one held in any workspace, whatever workspace a screen shows,
   * because the route names none (ADR-0022 amendment 7 S5).
   */
  scope?: "any";
}

export const ROLE_ACTIONS = {
  // Integrations
  "integration.adopt": { route: "POST /api/integrations/providers", role: "platform" },
  "integration.unadopt": {
    route: "DELETE /api/integrations/providers/:service",
    role: "platform",
  },
  "integration.connect": {
    route: "POST /api/integrations/workspaces/:workspaceId/connections/api-key",
    role: "admin",
  },
  "integration.revoke": {
    route: "DELETE /api/integrations/workspaces/:workspaceId/connections/:connectionId",
    role: "admin",
  },
  "connector.register": { route: "POST /api/connectors", role: "admin" },
  // Workspaces and bots (W8: an Owner or Admin of any workspace creates one)
  "workspace.create": { route: "POST /api/workspaces", role: "admin", scope: "any" },
  "workspace.configure": { route: "PATCH /api/workspaces/:id", role: "admin" },
  "trash.view": { route: "GET /api/trash", role: "admin" },
  "workspace.archive": { route: "POST /api/workspaces/:id/archive", role: "admin" },
  "workspace.restore": { route: "POST /api/workspaces/:id/restore", role: "admin" },
  "workspace.delete": { route: "DELETE /api/workspaces/:id", role: "admin" },
  "bot.create": { route: "POST /api/bots", role: "admin" },
  "bot.configure": { route: "PATCH /api/bots/:id", role: "admin" },
  "bot.editSoul": { route: "PATCH /api/bots/:id/soul", role: "admin" },
  "bot.archive": { route: "POST /api/bots/:id/archive", role: "admin" },
  "bot.restore": { route: "POST /api/bots/:id/restore", role: "admin" },
  "bot.delete": { route: "DELETE /api/bots/:id", role: "admin" },
  // Chats and tasks (amendment 6 W4 to W7)
  "sideChat.open": { route: "POST /api/threads", role: "guest" },
  "thread.create": {
    route: "POST /api/threads",
    role: "admin",
    handlerCheck: "a Member or Guest opens only a private chat with one bot",
  },
  "thread.read": { route: "GET /api/threads/:id/messages", role: "guest" },
  // A Guest asks in their own private inquiry; a status job answers (amendment 7 S1).
  "inquiry.ask": { route: "POST /api/threads/:id/messages", role: "guest" },
  "thread.post": {
    route: "POST /api/threads/:id/messages",
    role: "member",
    handlerCheck:
      "a Member posts in shared chats and their own private chats, never in a bus thread; a Guest posts nowhere yet",
  },
  "thread.postBus": {
    route: "POST /api/threads/:id/messages",
    role: "admin",
    handlerCheck: "only an Admin posts in a bus thread or adds a bot by a mention",
  },
  "privateChat.open": {
    route: "POST /api/bots/:id/private-chat",
    role: "admin",
    handlerCheck: "a Member or Guest gets an existing canonical chat only",
  },
  "thread.addMember": { route: "POST /api/threads/:id/members", role: "admin" },
  "thread.removeMember": { route: "DELETE /api/threads/:id/members/:botId", role: "admin" },
  "thread.setDeadline": { route: "PATCH /api/threads/:id", role: "admin" },
  "thread.closeTask": { route: "POST /api/threads/:id/close-task", role: "admin" },
  "task.create": { route: "POST /api/workspaces/:workspaceId/tasks", role: "admin" },
  "task.edit": { route: "PATCH /api/workspaces/:workspaceId/tasks/:id", role: "admin" },
  "task.accept": { route: "POST /api/workspaces/:workspaceId/tasks/:id/accept", role: "admin" },
  "task.submit": { route: "POST /api/workspaces/:id/submit", role: "member" },
  // Memory curation is configuration (C2)
  "memory.editFile": { route: "PATCH /api/bots/:id/memory", role: "admin" },
  "memory.consolidate": { route: "POST /api/bots/:id/memory/consolidate", role: "admin" },
  "memory.editEntry": { route: "PATCH /api/memory/entries/:id", role: "admin" },
  "memory.forget": { route: "POST /api/memory/entries/:id/forget", role: "admin" },
  "memory.undo": { route: "POST /api/memory/entries/:id/undo", role: "admin" },
  "memory.confirm": { route: "POST /api/memory/entries/:id/confirm", role: "admin" },
  "memory.reviewSuggestion": { route: "POST /api/memory-suggestions/:id/review", role: "admin" },
  // ADR-0011 amendment 4: revalidation, drafts from observations and model organisation
  "memory.revalidate": {
    route: "POST /api/workspaces/:id/memory/revalidations/:itemId",
    role: "admin",
  },
  "memory.draftDocument": {
    route: "POST /api/workspaces/:id/memory/document-drafts",
    role: "admin",
  },
  "memory.organize": { route: "POST /api/workspaces/:id/memory/organize", role: "admin" },
  "memory.decideSplit": { route: "POST /api/workspaces/:id/memory/splits/:itemId", role: "admin" },
  "memory.maintenanceSettings": {
    route: "PUT /api/workspaces/:id/memory/maintenance",
    role: "admin",
  },
  // Approvals and costs
  "approval.decide": { route: "POST /api/approvals/:id/decide", role: "member" },
  "approval.decideAny": {
    route: "POST /api/approvals/:id/decide",
    role: "admin",
    handlerCheck: "a Member answers only approvals of the runs they started (W5)",
  },
  "approval.decidePersistent": {
    route: "POST /api/approvals/:id/decide",
    role: "admin",
    handlerCheck: "a Member answers allow_once or deny only (allow_always, allow this site)",
  },
  "run.cancel": {
    route: "POST /api/runs/:id/cancel",
    role: "admin",
    handlerCheck: "a Member cancels only the runs they started or of their private chat",
  },
  "run.continue": {
    route: "POST /api/runs/:id/continuation/decide",
    role: "admin",
    handlerCheck: "a Member answers a continuation ask only for the runs they started",
  },
  "costAlert.acknowledge": { route: "POST /api/cost-alerts/:id/acknowledge", role: "member" },
  "approvalRule.create": { route: "POST /api/bots/:id/approval-rules", role: "admin" },
  "approvalRule.delete": { route: "DELETE /api/approval-rules/:id", role: "admin" },
  "costRule.create": { route: "POST /api/cost-alert-rules", role: "admin" },
  "costRule.delete": { route: "DELETE /api/cost-alert-rules/:id", role: "admin" },
  // Workspace monetary budget (ADR-0032)
  "budget.set": { route: "PUT /api/budgets/:workspaceId", role: "admin" },
  "budget.continue": { route: "POST /api/budgets/:workspaceId/continue", role: "admin" },
  // Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2)
  "limits.set": { route: "PUT /api/workspaces/:id/limits", role: "admin" },
  // Working-directory settings (ADR-0036)
  "workdir.set": { route: "PUT /api/workspaces/:id/workdir", role: "admin" },
  // Published apps: every Member shares and stops sharing (ADR-0035, owner-decided 2026-10-14)
  "appShare.publish": { route: "POST /api/workspaces/:id/app-shares", role: "member" },
  "appShare.stop": { route: "DELETE /api/workspaces/:id/app-shares/:shareId", role: "member" },
  // Knowledge (ADR-0031 Q2: an Owner or Admin publishes)
  "knowledge.propose": { route: "POST /api/knowledge/proposals", role: "member" },
  "knowledge.review": { route: "POST /api/knowledge/proposals/:id/review", role: "admin" },
  "knowledge.edit": { route: "PATCH /api/knowledge/:id", role: "admin" },
  "knowledge.cleanup": { route: "POST /api/knowledge/versions/cleanup", role: "platform" },
  // The board (W10)
  "board.read": { route: "GET /api/workspaces/:id/board", role: "guest" },
  "board.post": { route: "POST /api/workspaces/:id/board", role: "guest" },
  "board.moderate": {
    route: "POST /api/workspaces/:id/board/:postId/moderate",
    role: "admin",
  },
  // People (W3, W4, W9)
  "people.manage": { route: "GET /api/members", role: "admin" },
  "people.invite": { route: "POST /api/invitations", role: "admin" },
  "people.inviteAdmin": { route: "POST /api/invitations", role: "admin" },
  "people.changeRole": { route: "PATCH /api/members/:userId", role: "admin" },
  "people.manageAdmins": {
    route: "PATCH /api/members/:userId",
    role: "owner",
    handlerCheck: "only an Owner demotes or removes an Admin, or grants or removes Owner",
  },
  // What each navigation link's screen reads (amendment 7 S6)
  "approvals.read": { route: "GET /api/approvals", role: "member" },
  "bots.read": { route: "GET /api/bots", role: "guest" },
  "costs.read": { route: "GET /api/costs", role: "member" },
  "desktops.read": { route: "GET /api/capacity", role: "member" },
  "files.read": { route: "GET /api/workspaces/:id/files", role: "member" },
  // ADR-0014 A5 decision 43: any Admin deletes an uploaded file
  "files.deleteUpload": {
    route: "DELETE /api/workspaces/:id/uploads/:uploadId/file",
    role: "admin",
  },
  "integrations.read": {
    route: "GET /api/integrations/workspaces/:workspaceId/connections",
    role: "member",
  },
  "knowledge.read": { route: "GET /api/knowledge", role: "member" },
  // Network profiles: Owners define, Admins select (ADR-0027 amendment 1 decision 12)
  "network.read": { route: "GET /api/network-profiles", role: "owner", scope: "any" },
  "network.define": { route: "POST /api/network-profiles", role: "owner", scope: "any" },
  "network.select": { route: "PUT /api/workspaces/:id/network-profiles", role: "admin" },
  "network.settings": { route: "PUT /api/workspaces/:id/network-settings", role: "admin" },
  "runs.read": { route: "GET /api/runs", role: "member" },
  "skills.read": { route: "GET /api/workspaces/:id/skills", role: "member" },
  "tasks.read": { route: "GET /api/workspaces/:workspaceId/tasks", role: "member" },
  "threads.list": { route: "GET /api/threads", role: "guest" },
  // Service principals and tenant SSO are the root's (ADR-0031 Q2)
  "servicePrincipal.manage": { route: "POST /api/service-principals", role: "root" },
} as const satisfies Record<string, RoleActionRule>;

export type RoleAction = keyof typeof ROLE_ACTIONS;

/** The role facts `GET /auth/session` returns for a signed-in person. */
export interface SessionRoles {
  /** The highest role held in any workspace of the tenant. */
  tenantRole: TenantRole;
  platformMaintainer: boolean;
  /** The protected root account (amendment 6 W2). */
  root?: boolean;
  /** The role in each workspace, by workspace id; a workspace absent here holds no role. */
  workspaceRoles?: Readonly<Record<string, TenantRole>>;
}

const RANK: Readonly<Record<TenantRole, number>> = { guest: 0, member: 1, admin: 2, owner: 3 };

/** Whether `role` is at least `minimum` in rank. */
export function workspaceRoleAtLeast(role: TenantRole, minimum: TenantRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * The role a session holds in one workspace: the root is Owner of every one; without a
 * workspace, or without the per-workspace list, the tenant-level role. Undefined: no role there.
 */
export function sessionRoleIn(
  roles: SessionRoles,
  workspaceId: string | undefined,
): TenantRole | undefined {
  if (roles.root) return "owner";
  if (workspaceId === undefined || roles.workspaceRoles === undefined) return roles.tenantRole;
  return roles.workspaceRoles[workspaceId];
}

/**
 * Whether a session with these roles may take the action, in `workspaceId` when the screen
 * shows one; the Gateway still decides.
 */
export function mayTakeAction(
  roles: SessionRoles,
  action: RoleAction,
  workspaceId?: string,
): boolean {
  const rule: RoleActionRule = ROLE_ACTIONS[action];
  const role = rule.role;
  if (role === "platform") return roles.platformMaintainer;
  if (role === "root") return roles.root === true;
  const held = sessionRoleIn(roles, rule.scope === "any" ? undefined : workspaceId);
  return held !== undefined && RANK[held] >= RANK[role];
}

/** One action of the role panel: which workspace role may take it (ADR-0022 amendment 7 S9). */
export interface RoleMatrixRow {
  action: RoleAction;
  /** The lowest role that may take it. */
  role: TenantRole;
  /** Per workspace role, what `mayTakeAction` answers for a person holding only that role. */
  allowed: Readonly<Record<TenantRole, boolean>>;
  /** Roles below `role` reach the route, but a handler lets them do only part (`handlerCheck`). */
  limitedBelow: boolean;
}

/**
 * What each workspace role may do, read from `ROLE_ACTIONS` and nothing else (amendment 7 S9),
 * in table order: `workspace` holds the actions a workspace role takes, with one answer per role
 * from the same rank check as `mayTakeAction`; `administrator` holds the actions only the root
 * or a platform maintainer takes, which no workspace role grants.
 */
export function roleActionMatrix(): {
  workspace: RoleMatrixRow[];
  administrator: RoleAction[];
} {
  const workspace: RoleMatrixRow[] = [];
  const administrator: RoleAction[] = [];
  for (const action of Object.keys(ROLE_ACTIONS) as RoleAction[]) {
    const rule: RoleActionRule = ROLE_ACTIONS[action];
    if (rule.role === "platform" || rule.role === "root") {
      administrator.push(action);
      continue;
    }
    const allowed = Object.fromEntries(
      WORKSPACE_ROLES.map((role) => [
        role,
        mayTakeAction(
          { tenantRole: role, platformMaintainer: false, workspaceRoles: { w: role } },
          action,
          "w",
        ),
      ]),
    ) as Record<TenantRole, boolean>;
    workspace.push({
      action,
      role: rule.role,
      allowed,
      limitedBelow: rule.handlerCheck !== undefined,
    });
  }
  return { workspace, administrator };
}

/** Who may take an action, in words a screen can show: "an Admin or Owner". */
export function actionRoleLabel(role: ActionRole): string {
  switch (role) {
    case "platform":
      return "a platform maintainer";
    case "root":
      return "the administrator account";
    case "owner":
      return "an Owner";
    case "admin":
      return "an Admin or Owner";
    case "member":
      return "a Member, Admin or Owner";
    case "guest":
      return "anyone in the workspace";
  }
}
