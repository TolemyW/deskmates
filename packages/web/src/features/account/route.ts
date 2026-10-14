// User Settings: `#/account` (Personal settings), `#/account/agent-access` and
// `#/account/workspaces` (ADR-0034 decision 7). The Workspaces page keeps its search and filters in
// the address (`?q=&filter=&role=`) and opens a workspace's full-page detail with `&ws=<id>`, so
// Back, reload and the switcher's "Manage all" land on the same page.

import type { TenantRole, WorkspaceDirectoryFilter } from "@deskmates/contracts";
import { TENANT_ROLES, isWorkspaceDirectoryFilter } from "@deskmates/contracts";
import { defineRoutes } from "../../app/routes.js";

/** Search and filters of the Workspaces list; absent fields are the defaults. */
export interface WorkspaceListState {
  q?: string;
  filter?: WorkspaceDirectoryFilter;
  role?: TenantRole;
}

declare module "../../app/routes.js" {
  interface RouteMap {
    account: {
      name: "account";
      /** Absent: Personal settings. */
      page?: "agent-access" | "workspaces";
      list?: WorkspaceListState;
      /** The workspace whose detail page is open (immutable id). */
      workspaceId?: string;
    };
  }
}

export function accountHref(): string {
  return "#/account";
}

export function agentAccessHref(): string {
  return "#/account/agent-access";
}

function listQuery(list: WorkspaceListState = {}, workspaceId?: string): string {
  const params = new URLSearchParams();
  if (list.q) params.set("q", list.q);
  if (list.filter && list.filter !== "all") params.set("filter", list.filter);
  if (list.role) params.set("role", list.role);
  if (workspaceId) params.set("ws", workspaceId);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The Workspaces list with this search and these filters. */
export function workspacesHref(list?: WorkspaceListState): string {
  return `#/account/workspaces${listQuery(list)}`;
}

/** A workspace's detail page; the list state rides along for "Back to workspace list". */
export function workspaceDetailHref(workspaceId: string, list?: WorkspaceListState): string {
  return `#/account/workspaces${listQuery(list, workspaceId)}`;
}

function parseAccount(rest: string | undefined) {
  if (!rest) return { name: "account" as const };
  const [page, search = ""] = rest.split("?", 2);
  if (page === "agent-access") return { name: "account" as const, page: "agent-access" as const };
  if (page !== "workspaces") return { name: "account" as const };
  const params = new URLSearchParams(search);
  const list: WorkspaceListState = {};
  const q = params.get("q")?.trim();
  if (q) list.q = q.slice(0, 64);
  const filter = params.get("filter");
  if (isWorkspaceDirectoryFilter(filter) && filter !== "all") list.filter = filter;
  const role = params.get("role");
  if (role && (TENANT_ROLES as readonly string[]).includes(role)) list.role = role as TenantRole;
  const ws = params.get("ws");
  return {
    name: "account" as const,
    page: "workspaces" as const,
    list,
    ...(ws ? { workspaceId: ws } : {}),
  };
}

export const routes = defineRoutes({
  screens: { account: "people-and-roles" },
  segments: { account: parseAccount },
});
