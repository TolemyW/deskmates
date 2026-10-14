// Files: `#/resources/files`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    files: { name: "files" };
  }
}

export function filesHref(): string {
  return "#/resources/files";
}

export const routes = defineRoutes({
  screens: { files: "workspaces" },
  segments: {
    resources: (rest) => (rest === "files" ? { name: "files" } : undefined),
  },
});
