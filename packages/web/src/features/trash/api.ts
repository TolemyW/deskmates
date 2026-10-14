// Trash: archived workspaces and bots, their restore and their permanent deletion. Deleting
// sends the name back as the confirmation the Gateway checks.

import type { BotDefinition, BotId, Workspace, WorkspaceId } from "@deskmates/contracts";
import { type HttpTransport, query } from "../../platform/http-transport.js";

export interface TrashApi {
  /**
   * One page of archived workspaces, newest first, with the total (#113); archived bots whole.
   * Without filters the Gateway answers its first page.
   */
  listTrash(filters?: { offset?: number; limit?: number }): Promise<{
    workspaces: Workspace[];
    bots: BotDefinition[];
    offset?: number;
    limit?: number;
    total?: number;
  }>;
  permanentlyDeleteBot(id: BotId, name: string): Promise<void>;
  permanentlyDeleteWorkspace(id: WorkspaceId, name: string): Promise<void>;
  restoreBot(id: BotId): Promise<BotDefinition>;
  restoreWorkspace(id: WorkspaceId): Promise<Workspace>;
}

export function createTrashApi(t: HttpTransport): TrashApi {
  return {
    listTrash(filters = {}) {
      return t.json("GET", `/api/trash${query({ ...filters })}`);
    },
    async permanentlyDeleteBot(id, name) {
      await t.json("DELETE", `/api/bots/${encodeURIComponent(id)}`, { name });
    },
    async permanentlyDeleteWorkspace(id, name) {
      await t.json("DELETE", `/api/workspaces/${encodeURIComponent(id)}`, { name });
    },
    async restoreBot(id) {
      return (
        await t.json<{ bot: BotDefinition }>("POST", `/api/bots/${encodeURIComponent(id)}/restore`)
      ).bot;
    },
    async restoreWorkspace(id) {
      return (
        await t.json<{ workspace: Workspace }>(
          "POST",
          `/api/workspaces/${encodeURIComponent(id)}/restore`,
        )
      ).workspace;
    },
  };
}
