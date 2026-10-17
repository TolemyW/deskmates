// Opening a published app (ADR-0035 decision 3): `#/apps/<share id>?ws=<workspace id>[&path=/x]`.
// The page asks the Gateway for a one-use ticket and submits it to the app's own origin. The app
// origin's sign-in hint links here in the same shape.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    appOpen: { name: "appOpen"; workspaceId: string; shareId: string; path?: string };
  }
}

export function appOpenHref(workspaceId: string, shareId: string, path?: string): string {
  const query = new URLSearchParams({ ws: workspaceId });
  if (path && path !== "/") query.set("path", path);
  return `#/apps/${encodeURIComponent(shareId)}?${query.toString()}`;
}

function parseApps(rest: string | undefined) {
  const [address = "", search = ""] = (rest ?? "").split("?", 2);
  const params = new URLSearchParams(search);
  const shareId = decodeURIComponent(address);
  const workspaceId = params.get("ws");
  if (!shareId || !workspaceId) return undefined;
  const path = params.get("path");
  return {
    name: "appOpen" as const,
    workspaceId,
    shareId,
    // Only a path on the app itself; anything else opens its start page.
    ...(path?.startsWith("/") && !path.startsWith("//") ? { path } : {}),
  };
}

export const routes = defineRoutes({
  screens: { appOpen: "workspaces" },
  segments: { apps: parseApps },
});
