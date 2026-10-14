// Approvals, the attention inbox: `#/approvals`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    approvals: { name: "approvals" };
  }
}

export function approvalsHref(): string {
  return "#/approvals";
}

export const routes = defineRoutes({
  screens: { approvals: "approvals" },
  segments: { approvals: () => ({ name: "approvals" }) },
});
