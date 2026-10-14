// Tasks: `#/tasks[/<task id>]`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    tasks: { name: "tasks"; id?: string };
  }
}

export function taskHref(id?: string): string {
  return id ? `#/tasks/${encodeURIComponent(id)}` : "#/tasks";
}

export const routes = defineRoutes({
  screens: { tasks: "tasks" },
  segments: {
    tasks: (rest) => (rest ? { name: "tasks", id: decodeURIComponent(rest) } : { name: "tasks" }),
  },
});
