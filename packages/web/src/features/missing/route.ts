// Unknown top-level hash paths are terminal 404 pages (#20). This module has no owned segment:
// the registry constructs the route only when no registered feature owns the typed segment.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    notFound: { name: "notFound"; path: string };
  }
}

export const routes = defineRoutes({
  screens: { notFound: "getting-started" },
  segments: {},
});
