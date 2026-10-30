// Connections: `#/connections/<tab>`, chat channels first (owner, 2026-10-22). The former
// Integrations address `#/integrations` opens the Apps tab, where its catalog was.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    connections: { name: "connections"; tab: ConnectionsTab };
  }
}

/** Chat channels people use to reach bots, apps bots use, and receipted databases. */
export type ConnectionsTab = "channels" | "apps" | "databases";

export const CONNECTIONS_TABS: readonly ConnectionsTab[] = ["channels", "apps", "databases"];

function connectionsTab(segment: string | undefined): ConnectionsTab {
  return segment === "apps" || segment === "databases" ? segment : "channels";
}

export function connectionsHref(tab: ConnectionsTab = "channels"): string {
  return `#/connections/${tab}`;
}

export const routes = defineRoutes({
  screens: { connections: "integrations-and-connectors" },
  segments: {
    connections: (rest) => ({ name: "connections", tab: connectionsTab(rest) }),
    integrations: () => ({ name: "connections", tab: "apps" }),
  },
  canonicalHref: (route) => connectionsHref(route.tab),
});
