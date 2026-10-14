// Runs: `#/runs/<run id>`, a detail drawer over the screen that was showing.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    runs: { name: "runs"; id: string };
  }
}

export function runHref(id: string): string {
  return `#/runs/${encodeURIComponent(id)}`;
}

export const routes = defineRoutes({
  screens: { runs: "chats-and-groups" },
  segments: {
    runs: (rest) => (rest ? { name: "runs", id: decodeURIComponent(rest) } : undefined),
  },
});
