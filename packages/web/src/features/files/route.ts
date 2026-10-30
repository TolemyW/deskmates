// Files: `#/resources/files[?workspace=<id>&path=<path>]`. With a path, the screen opens at the
// file's directory with the file selected (ADR-0014 amendment A7, a chat card's "Show in Files").

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    files: { name: "files"; workspaceId?: string; path?: string };
    fileReader: { name: "fileReader"; workspaceId: string; path: string };
  }
}

/** The Files screen, or one workspace file in it. */
export function filesHref(target?: { workspaceId: string; path: string }): string {
  if (!target) return "#/resources/files";
  const query = new URLSearchParams({ workspace: target.workspaceId, path: target.path });
  return `#/resources/files?${query.toString()}`;
}

/** A static report opens under the signed-in operator's existing origin, never an app subdomain. */
export function fileReadHref(target: { workspaceId: string; path: string }): string {
  const query = new URLSearchParams({
    workspace: target.workspaceId,
    path: target.path,
    view: "read",
  });
  return `#/resources/files?${query.toString()}`;
}

export const routes = defineRoutes({
  screens: { files: "workspaces", fileReader: "workspaces" },
  segments: {
    resources: (rest) => {
      const [segment, query] = (rest ?? "").split("?", 2);
      if (segment !== "files") return undefined;
      const params = new URLSearchParams(query);
      const workspaceId = params.get("workspace");
      const path = params.get("path");
      if (params.get("view") === "read")
        return workspaceId && path ? { name: "fileReader", workspaceId, path } : undefined;
      return {
        name: "files",
        ...(workspaceId ? { workspaceId } : {}),
        ...(path ? { path } : {}),
      };
    },
  },
});
