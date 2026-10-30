// The workspace Vault (ADR-0045): `#/vault`, for the selected workspace.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    vault: { name: "vault" };
  }
}

export function vaultHref(): string {
  return "#/vault";
}

export const routes = defineRoutes({
  screens: { vault: "integrations-and-connectors" },
  segments: { vault: () => ({ name: "vault" }) },
});
