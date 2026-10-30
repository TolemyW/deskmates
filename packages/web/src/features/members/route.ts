// People: `#/members`. Only an Owner or Admin sees it.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    members: { name: "members" };
  }
}

export function membersHref(): string {
  return "#/members";
}

export const routes = defineRoutes({
  screens: { members: "people-and-roles" },
  segments: { members: () => ({ name: "members" }) },
  // Legacy feature-level helpers still describe Chats to a Member. The shell checks the typed
  // route's read action first and renders the explicit no-permission page (#20).
  shown: (route, roles) => (roles.manager ? route : { name: "threads" }),
});
