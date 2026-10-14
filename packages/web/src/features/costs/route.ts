// Costs: `#/costs`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    costs: { name: "costs" };
  }
}

export function costsHref(): string {
  return "#/costs";
}

export const routes = defineRoutes({
  screens: { costs: "costs" },
  segments: { costs: () => ({ name: "costs" }) },
});
