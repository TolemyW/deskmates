// Workspace trash: `#/trash`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    trash: { name: "trash" };
  }
}

export function trashHref(): string {
  return "#/trash";
}

export const routes = defineRoutes({
  screens: { trash: "workspaces" },
  segments: { trash: () => ({ name: "trash" }) },
});
