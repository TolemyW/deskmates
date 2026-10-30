// The `web_search` switch (ADR-0049 decision 4): read whether the installation configures search
// and what this workspace chose, and set it (Owner or Admin). Off by default; runs already started
// keep what they froze.

import type { WebSearchInput, WebSearchView } from "@deskmates/contracts";
import type { HttpTransport } from "../../platform/http-transport.js";

export interface WebSearchApi {
  getWorkspaceWebSearch(workspaceId: string): Promise<WebSearchView>;
  /** `enabled: null` returns to the configured default (on). */
  setWorkspaceWebSearch(workspaceId: string, input: WebSearchInput): Promise<WebSearchView>;
}

export function createWebSearchApi(t: HttpTransport): WebSearchApi {
  const path = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/web-search`;
  return {
    async getWorkspaceWebSearch(workspaceId) {
      return (await t.json<{ webSearch: WebSearchView }>("GET", path(workspaceId))).webSearch;
    },
    async setWorkspaceWebSearch(workspaceId, input) {
      return (await t.json<{ webSearch: WebSearchView }>("PUT", path(workspaceId), input))
        .webSearch;
    },
  };
}
