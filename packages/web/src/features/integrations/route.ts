// Integrations: `#/integrations`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    integrations: { name: "integrations" };
  }
}

export function integrationsHref(): string {
  return "#/integrations";
}

export const routes = defineRoutes({
  screens: { integrations: "integrations-and-connectors" },
  segments: { integrations: () => ({ name: "integrations" }) },
});
