// Published workspace apps (ADR-0035): list a workspace's publications with their live state,
// share a running port, get a one-use entry ticket for one, and stop sharing one (any Member).

import type { AppPublishResponse, AppShare, AppShareOpenResponse } from "@deskmates/contracts";
import type { HttpTransport } from "../../platform/http-transport.js";

export interface AppShareList {
  /** False when the Gateway has no app listener configured. */
  enabled: boolean;
  shares: AppShare[];
}

export interface AppSharesApi {
  listAppShares(workspaceId: string): Promise<AppShareList>;
  openAppShare(workspaceId: string, shareId: string, path?: string): Promise<AppShareOpenResponse>;
  /** A Member shares a running port (owner-decided 2026-10-14); the same port relabels. */
  publishAppShare(workspaceId: string, port: number, label: string): Promise<AppPublishResponse>;
  revokeAppShare(workspaceId: string, shareId: string): Promise<AppShare>;
}

export function createAppSharesApi(t: HttpTransport): AppSharesApi {
  const base = (workspaceId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/app-shares`;
  const one = (workspaceId: string, shareId: string) =>
    `${base(workspaceId)}/${encodeURIComponent(shareId)}`;
  return {
    listAppShares: (workspaceId) => t.json<AppShareList>("GET", base(workspaceId)),
    openAppShare: (workspaceId, shareId, path) =>
      t.json<AppShareOpenResponse>(
        "POST",
        `${one(workspaceId, shareId)}/open`,
        path ? { path } : {},
      ),
    publishAppShare: (workspaceId, port, label) =>
      t.json<AppPublishResponse>("POST", base(workspaceId), { port, label }),
    async revokeAppShare(workspaceId, shareId) {
      return (await t.json<{ share: AppShare }>("DELETE", one(workspaceId, shareId))).share;
    },
  };
}
