// The route table, assembled from every feature's `route.ts` (found with `import.meta.glob`) and
// the shell's invitation route. `router.ts` exposes it; nothing here names a feature.

import type { GuidePage } from "../lib/guide.js";
import { routes as inviteRoutes } from "./invite-route.js";
import type { Route, RouteModule, RouteName, RouteRoles, SegmentParser } from "./routes.js";

const featureModules = import.meta.glob<RouteModule>("../features/*/route.ts", {
  eager: true,
  import: "routes",
});

/** The owner of the shell's own routes, beside the feature folder names. */
export const SHELL_OWNER = "app";

/** `../features/<feature>/route.ts` -> `<feature>`. */
function featureFolder(path: string): string {
  return path.split("/").at(-2) ?? path;
}

/** Every route module, keyed by its owner: `app` for the shell, else the feature folder name. */
export const ROUTE_MODULES: ReadonlyMap<string, RouteModule> = new Map([
  [SHELL_OWNER, inviteRoutes as RouteModule],
  ...Object.entries(featureModules)
    .map(([path, module]): [string, RouteModule] => [featureFolder(path), module])
    .sort(([a], [b]) => a.localeCompare(b)),
]);

const owners = new Map<RouteName, string>();
const modules = new Map<RouteName, RouteModule>();
const segments = new Map<string, SegmentParser>();
for (const [owner, module] of ROUTE_MODULES) {
  for (const name of Object.keys(module.screens) as RouteName[]) {
    const other = owners.get(name);
    if (other !== undefined) throw new Error(`route ${name} is owned by ${other} and ${owner}`);
    owners.set(name, owner);
    modules.set(name, module);
  }
  for (const [segment, parse] of Object.entries(module.segments)) {
    if (segments.has(segment)) throw new Error(`path segment ${segment} has two owners`);
    segments.set(segment, parse);
  }
}

/** The owner (`app` or a feature folder name) of a route name. */
export function routeOwner(name: RouteName): string | undefined {
  return owners.get(name);
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const [head, rest] = path.split("/", 2);
  // A fresh object each time: the shell's effects run when the route object changes.
  if (!head) return { name: "home" };
  const parser = segments.get(head);
  if (!parser) return { name: "notFound", path };
  return parser(rest) ?? { name: "home" };
}

/**
 * The current address of a page reached through an older or shortened hash, or undefined when
 * the hash is already current (or its route keeps the address as typed).
 */
export function legacyRedirect(hash: string): string | undefined {
  const route = parseRoute(hash);
  const canonical = modules.get(route.name)?.canonicalHref?.(route);
  if (canonical === undefined) return undefined;
  const current = `#/${hash.replace(/^#/, "").replace(/^\/+/, "")}`;
  return current === canonical ? undefined : canonical;
}

/**
 * The route whose screen the shell shows for a route, after its owner's redirects: People is
 * Chats for a Member, and the legacy `#/desktops` renders the contacts list.
 */
export function shownRoute(route: Route, roles: RouteRoles): Route {
  return modules.get(route.name)?.shown?.(route, roles) ?? route;
}

/** The guide page of each route that is a screen of the signed-in UI. */
export function routeGuidePages(): Array<[RouteName, GuidePage]> {
  const pages: Array<[RouteName, GuidePage]> = [];
  for (const module of ROUTE_MODULES.values())
    for (const [name, page] of Object.entries(module.screens) as Array<
      [RouteName, GuidePage | null]
    >)
      if (page !== null) pages.push([name, page]);
  return pages;
}
