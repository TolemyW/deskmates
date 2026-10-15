// Runs index: `#/run-index` (issue #11, ADR-0042). A row opens the run drawer (`#/runs/<id>`),
// which the runs feature owns.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    runIndex: { name: "runIndex" };
  }
}

export function runIndexHref(): string {
  return "#/run-index";
}

export const routes = defineRoutes({
  screens: { runIndex: "chats-and-groups" },
  segments: { "run-index": () => ({ name: "runIndex" }) },
});
