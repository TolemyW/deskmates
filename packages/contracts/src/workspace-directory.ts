// The workspace directory (ADR-0034 decisions 3 to 6, issue #117): the paged list behind the
// Workspaces page of User Settings and the switcher's pinned, recent and search results.

import type { TenantRole } from "./auth.js";
import type { WorkspaceId } from "./ids.js";
import type { OffsetPageMeta, PageLimitPolicy } from "./pagination.js";

/** 20 rows a page, at most 100 (#113 surface 40, owner choice on #117). */
export const WORKSPACE_DIRECTORY_PAGE: PageLimitPolicy = { default: 20, max: 100 };

/** The longest search text the directory accepts. */
export const WORKSPACE_DIRECTORY_QUERY_MAX = 64;

export const WORKSPACE_DIRECTORY_FILTERS = ["all", "pinned", "archived"] as const;
export type WorkspaceDirectoryFilter = (typeof WORKSPACE_DIRECTORY_FILTERS)[number];

export function isWorkspaceDirectoryFilter(value: unknown): value is WorkspaceDirectoryFilter {
  return (WORKSPACE_DIRECTORY_FILTERS as readonly unknown[]).includes(value);
}

/** One row: names, the caller's role and authorized aggregates, never content. */
export interface WorkspaceDirectoryEntry {
  id: WorkspaceId;
  name: string;
  /** The caller's role there (Owner for the operator credential and the protected account). */
  myRole: TenantRole;
  pinned: boolean;
  /** Active bots. */
  botCount: number;
  /** Queued, running or waiting runs; null where the caller is below Admin (decision 5). */
  activeRuns: number | null;
  /** Latest chat activity the caller may see, or the creation time. */
  lastActivityAt: string;
  createdAt: string;
  archivedAt?: string;
  /** True when the egress allowlist is the open public internet (`*`). */
  openInternet: boolean;
}

export interface WorkspaceDirectoryPage extends OffsetPageMeta {
  workspaces: WorkspaceDirectoryEntry[];
}

export interface WorkspaceDirectoryQuery {
  q?: string;
  filter?: WorkspaceDirectoryFilter;
  role?: TenantRole;
  offset?: number;
  limit?: number;
}
