// Workspaces: the list, creation, archiving, renaming, the egress allowlist (ADR-0020), and the
// paged directory with personal pins (ADR-0034).

import type {
  BotDefinition,
  Thread,
  Workspace,
  WorkspaceDirectoryPage,
  WorkspaceDirectoryQuery,
  WorkspaceId,
} from "@deskmates/contracts";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

export interface CreateWorkspaceInput {
  name: string;
  sandboxProvider?: Workspace["sandboxProvider"];
  egressAllowlist?: string[];
  probeUrl?: string;
  probeExpectText?: string;
}

/** A created workspace with its default bot and that bot's private chat (ADR-0051 decision 2). */
export interface CreatedWorkspace {
  workspace: Workspace;
  defaultBot?: BotDefinition;
  privateChat?: Thread;
}

export interface WorkspacesApi {
  archiveWorkspace(id: WorkspaceId): Promise<Workspace>;
  createWorkspace(input: CreateWorkspaceInput): Promise<CreatedWorkspace>;
  /** One page of the caller's workspaces, 20 by default (ADR-0034 decision 3). */
  listWorkspaceDirectory(filters?: WorkspaceDirectoryQuery): Promise<WorkspaceDirectoryPage>;
  listWorkspaces(): Promise<Workspace[]>;
  renameWorkspace(id: WorkspaceId, name: string): Promise<Workspace>;
  /** The caller's own pin (ADR-0034 decision 6). */
  setWorkspacePinned(id: WorkspaceId, pinned: boolean): Promise<void>;
  updateWorkspaceEgress(id: WorkspaceId, egressAllowlist: string[]): Promise<Workspace>;
}

export function createWorkspacesApi(t: HttpTransport): WorkspacesApi {
  return {
    async archiveWorkspace(id) {
      return (
        await t.json<{ workspace: Workspace }>(
          "POST",
          `/api/workspaces/${encodeURIComponent(id)}/archive`,
        )
      ).workspace;
    },
    createWorkspace(input) {
      return t.json<CreatedWorkspace>("POST", "/api/workspaces", stripUndefined(input));
    },
    listWorkspaceDirectory(filters = {}) {
      return t.json("GET", `/api/workspace-directory${query({ ...filters })}`);
    },
    async listWorkspaces() {
      const r = await t.json<{ workspaces: Workspace[] }>("GET", "/api/workspaces");
      return r.workspaces;
    },
    async renameWorkspace(id, name) {
      return (
        await t.json<{ workspace: Workspace }>(
          "PATCH",
          `/api/workspaces/${encodeURIComponent(id)}`,
          {
            name,
          },
        )
      ).workspace;
    },
    async setWorkspacePinned(id, pinned) {
      await t.json(pinned ? "PUT" : "DELETE", `/api/workspaces/${encodeURIComponent(id)}/pin`);
    },
    async updateWorkspaceEgress(id, egressAllowlist) {
      return (
        await t.json<{ workspace: Workspace }>(
          "PATCH",
          `/api/workspaces/${encodeURIComponent(id)}`,
          {
            egressAllowlist,
          },
        )
      ).workspace;
    },
  };
}
