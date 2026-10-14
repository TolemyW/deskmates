// Network profiles (ADR-0027 amendment 1): `#/network`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    network: { name: "network" };
  }
}

export function networkHref(): string {
  return "#/network";
}

export const routes = defineRoutes({
  screens: { network: "workspaces" },
  segments: { network: () => ({ name: "network" }) },
});
