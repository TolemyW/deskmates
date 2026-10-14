// Computer: `#/computer`. The older `#/manage` opens it too (issue #27).

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    computer: { name: "computer" };
  }
}

export function computerHref(): string {
  return "#/computer";
}

export const routes = defineRoutes({
  screens: { computer: "workspaces" },
  segments: {
    computer: () => ({ name: "computer" }),
    manage: () => ({ name: "computer" }),
  },
  canonicalHref: () => computerHref(),
});
