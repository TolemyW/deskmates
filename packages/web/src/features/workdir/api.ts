// Working-directory settings (ADR-0036): read the stored and effective values, and set or clear
// them (Owner or Admin). A convention and tooling, never access control between bots.

import type { WorkdirSettingsInput, WorkdirSettingsView } from "@deskmates/contracts";
import type { HttpTransport } from "../../platform/http-transport.js";

export interface WorkdirApi {
  getWorkspaceWorkdir(workspaceId: string): Promise<WorkdirSettingsView>;
  /** A field with a value sets it, `null` clears it (inherit), an omitted field is unchanged. */
  setWorkspaceWorkdir(
    workspaceId: string,
    input: WorkdirSettingsInput,
  ): Promise<WorkdirSettingsView>;
}

export function createWorkdirApi(t: HttpTransport): WorkdirApi {
  const path = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/workdir`;
  return {
    async getWorkspaceWorkdir(workspaceId) {
      return (await t.json<{ workdir: WorkdirSettingsView }>("GET", path(workspaceId))).workdir;
    },
    async setWorkspaceWorkdir(workspaceId, input) {
      return (await t.json<{ workdir: WorkdirSettingsView }>("PUT", path(workspaceId), input))
        .workdir;
    },
  };
}
