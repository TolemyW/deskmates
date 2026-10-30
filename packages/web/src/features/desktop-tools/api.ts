// Opt-in native desktop tools (ADR-0048 decision 1): read the workspace's switches, the image's
// capability and the grouping exception; set them (Owner or Admin). Runs already started keep
// what they froze.

import type { DesktopToolsInput, DesktopToolsView } from "@deskmates/contracts";
import type { HttpTransport } from "../../platform/http-transport.js";

export interface DesktopToolsApi {
  getWorkspaceDesktopTools(workspaceId: string): Promise<DesktopToolsView>;
  /** An omitted field is unchanged; `bots` maps a bot id to on or off. */
  setWorkspaceDesktopTools(
    workspaceId: string,
    input: DesktopToolsInput,
  ): Promise<DesktopToolsView>;
}

export function createDesktopToolsApi(t: HttpTransport): DesktopToolsApi {
  const path = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/desktop-tools`;
  return {
    async getWorkspaceDesktopTools(workspaceId) {
      return (await t.json<{ desktopTools: DesktopToolsView }>("GET", path(workspaceId)))
        .desktopTools;
    },
    async setWorkspaceDesktopTools(workspaceId, input) {
      return (await t.json<{ desktopTools: DesktopToolsView }>("PUT", path(workspaceId), input))
        .desktopTools;
    },
  };
}
