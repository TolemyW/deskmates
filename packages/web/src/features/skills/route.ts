// Skills: `#/skills`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    skills: { name: "skills" };
  }
}

export function skillsHref(): string {
  return "#/skills";
}

export const routes = defineRoutes({
  screens: { skills: "workspaces" },
  segments: { skills: () => ({ name: "skills" }) },
  canonicalHref: () => skillsHref(),
});
