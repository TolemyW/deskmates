// @vitest-environment jsdom
// T0: invariants of the feature registry (issue #53), computed over whatever features exist.
// What one feature renders and how its link looks is in that feature's own `feature.test.tsx`.

import { describe, expect, it } from "vitest";
import { parseRoute } from "../router.js";
import { FEATURES, drawerFeatures, featureFor, navigationGroups } from "./features.js";
import { ROUTE_MODULES, SHELL_OWNER, routeOwner, shownRoute } from "./route-registry.js";
import type { RouteName } from "./routes.js";
import { STUB_CONTEXT, currentEntries } from "./testing/feature-expectations.js";

/** Every address the route modules parse: each segment bare and with a second segment. */
function addresses(): string[] {
  const hashes = [""];
  for (const module of ROUTE_MODULES.values())
    for (const segment of Object.keys(module.segments))
      hashes.push(`#/${segment}`, `#/${segment}/x`);
  return hashes;
}

describe("feature registry", () => {
  it("renders every route from the route module of the same feature folder", () => {
    for (const [owner, module] of ROUTE_MODULES) {
      for (const name of Object.keys(module.screens) as RouteName[]) {
        const feature = featureFor({ name } as never);
        if (owner === SHELL_OWNER) {
          expect(feature, name).toBeUndefined();
          continue;
        }
        expect(feature, name).toBe(FEATURES.get(owner));
        expect(feature?.routes, name).toBe(module);
        expect(routeOwner(name)).toBe(owner);
      }
    }
    for (const folder of FEATURES.keys()) expect(ROUTE_MODULES.has(folder), folder).toBe(true);
  });

  it("renders a screen for every signed-in address, for a manager and a Member", () => {
    for (const hash of addresses()) {
      const route = parseRoute(hash);
      if (routeOwner(route.name) === SHELL_OWNER) continue;
      for (const manager of [true, false]) {
        const shown = shownRoute(route, { manager });
        const element = featureFor(shown)?.render(shown, { ...STUB_CONTEXT, manager });
        expect(element, `${hash} manager=${manager}`).toBeTruthy();
      }
    }
  });

  it("labels every drawer for screen readers and its close button", () => {
    for (const [folder, feature] of drawerFeatures()) {
      expect(feature.drawer?.title, folder).toBeTruthy();
      expect(feature.drawer?.closeLabel, folder).toBeTruthy();
    }
  });

  it("places each navigation entry once in its group", () => {
    for (const { group, entries } of navigationGroups()) {
      const orders = entries.map((entry) => entry.nav.order);
      expect(new Set(orders).size, group).toBe(orders.length);
    }
    const placed = navigationGroups().flatMap(({ entries }) => entries.map((e) => e.folder));
    const declared = [...FEATURES].filter(([, f]) => f.nav).map(([folder]) => folder);
    expect(placed.sort()).toEqual(declared.sort());
  });

  it("marks at most one navigation entry current at any address", () => {
    for (const hash of addresses())
      expect(currentEntries(hash).length, hash).toBeLessThanOrEqual(1);
  });
});
