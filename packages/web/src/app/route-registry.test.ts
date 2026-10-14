// @vitest-environment node
// T0: invariants of the route table assembled from feature route modules (issue #53), computed
// over whatever modules exist: one owner per route and per path segment, owners are folders
// under src/features (or the shell), every screen has a guide page, and an address parses back from
// the one its owner redirects it to. Each feature's own addresses are in its `route.test.ts`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { type GuideScreen, SCREEN_GUIDE_PAGES, screenGuidePage } from "../lib/guide.js";
import {
  ROUTE_MODULES,
  SHELL_OWNER,
  legacyRedirect,
  parseRoute,
  routeOwner,
  shownRoute,
} from "./route-registry.js";
import type { Route, RouteMap, RouteName } from "./routes.js";

/** Folders under `src/features/`; read from disk so a new feature edits no shared list. */
const FEATURE_FOLDERS = readdirSync(fileURLToPath(new URL("../features/", import.meta.url)), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** Addresses built from every segment the route modules parse, with assorted second segments. */
function addresses(): string[] {
  const hashes = [""];
  for (const module of ROUTE_MODULES.values())
    for (const segment of Object.keys(module.segments))
      for (const rest of [undefined, "", "x", "new", "files", "observations", "settings"])
        hashes.push(rest === undefined ? `#/${segment}` : `#/${segment}/${rest}`);
  return hashes;
}

describe("route registry", () => {
  it("keys every route object by its own name", () => {
    expectTypeOf<{ [K in RouteName]: RouteMap[K]["name"] }>().toEqualTypeOf<{
      [K in RouteName]: K;
    }>();
    expectTypeOf<Route["name"]>().toEqualTypeOf<RouteName>();
  });

  it("names a feature folder of the feature map, or the shell, as each module's owner", () => {
    for (const owner of ROUTE_MODULES.keys())
      expect([SHELL_OWNER, ...FEATURE_FOLDERS], owner).toContain(owner);
  });

  it("gives every route exactly one owner", () => {
    const seen = new Map<string, string>();
    for (const [owner, module] of ROUTE_MODULES)
      for (const name of Object.keys(module.screens)) {
        expect(seen.get(name), `${name} owned twice`).toBeUndefined();
        seen.set(name, owner);
        expect(routeOwner(name as RouteName)).toBe(owner);
      }
  });

  it("parses each first path segment in exactly one module", () => {
    const seen = new Set<string>();
    for (const module of ROUTE_MODULES.values())
      for (const segment of Object.keys(module.segments)) {
        expect(seen.has(segment), segment).toBe(false);
        seen.add(segment);
      }
  });

  it("parses every address to a route with an owner, and back from its canonical address", () => {
    for (const hash of addresses()) {
      const route = parseRoute(hash);
      expect(routeOwner(route.name), hash).toBeDefined();
      const next = legacyRedirect(hash);
      if (next !== undefined) {
        expect(parseRoute(next), hash).toEqual(route);
        expect(legacyRedirect(next), next).toBeUndefined();
      }
    }
  });

  it("shows a route of the same or another owner, never an unowned one", () => {
    for (const hash of addresses())
      for (const manager of [true, false])
        expect(routeOwner(shownRoute(parseRoute(hash), { manager }).name), hash).toBeDefined();
  });

  it("names a guide page for every signed-in screen, and for every address and role", () => {
    for (const module of ROUTE_MODULES.values())
      for (const [name, page] of Object.entries(module.screens)) {
        if (page !== null) expect(SCREEN_GUIDE_PAGES[name as GuideScreen], name).toBe(page);
        else expect(name in SCREEN_GUIDE_PAGES, name).toBe(false);
      }
    for (const hash of addresses())
      for (const manager of [true, false])
        expect(screenGuidePage(parseRoute(hash), { manager }), hash).toBeTruthy();
  });

  it("keeps route modules free of screens: they import only the route types", () => {
    // Screens import `router.ts`, which loads every route module; a screen import here is a cycle.
    for (const feature of FEATURE_FOLDERS) {
      const path = fileURLToPath(new URL(`../features/${feature}/route.ts`, import.meta.url));
      if (!existsSync(path)) continue;
      const specifiers = [...readFileSync(path, "utf8").matchAll(/from\s+"([^"]+)"/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers)
        expect(["../../app/routes.js", "@deskmates/contracts"], `${feature}/route.ts`).toContain(
          specifier,
        );
    }
  });
});
