// People: `#/members`. Only an Owner or Admin sees it; for a Member the address shows Chats.

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
  shown: (route, roles) => (roles.manager ? route : { name: "threads" }),
});
