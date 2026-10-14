// The workspace message board: `#/board`. Every role sees it, Guests included (ADR-0022
// amendment 6 W10).

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    board: { name: "board" };
  }
}

export function boardHref(): string {
  return "#/board";
}

export const routes = defineRoutes({
  screens: { board: "workspaces" },
  segments: { board: () => ({ name: "board" }) },
});
