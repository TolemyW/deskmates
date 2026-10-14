// Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2): read the effective
// values with their sources, and set or clear the stored settings (Owner or Admin).

import type { WorkspaceLimitsInput, WorkspaceLimitsView } from "@deskmates/contracts";
import type { HttpTransport } from "../../platform/http-transport.js";

export interface LimitsApi {
  getWorkspaceLimits(workspaceId: string): Promise<WorkspaceLimitsView>;
  /** A key with a value sets it, `null` clears it (inherit), an omitted key is unchanged. */
  setWorkspaceLimits(
    workspaceId: string,
    input: WorkspaceLimitsInput,
  ): Promise<WorkspaceLimitsView>;
}

export function createLimitsApi(t: HttpTransport): LimitsApi {
  const path = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/limits`;
  return {
    async getWorkspaceLimits(workspaceId) {
      return (await t.json<{ limits: WorkspaceLimitsView }>("GET", path(workspaceId))).limits;
    },
    async setWorkspaceLimits(workspaceId, input) {
      return (await t.json<{ limits: WorkspaceLimitsView }>("PUT", path(workspaceId), input))
        .limits;
    },
  };
}
