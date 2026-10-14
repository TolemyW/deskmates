// Test-only: the expectations a route module's own `route.test.ts` states (issue #53). Each
// feature lists its addresses, href helpers, guide pages and role views next to its code, so a
// new screen adds a test file instead of editing a central table. Never imported by app code.

import { describe, expect, it } from "vitest";
import type { GuidePage } from "../../lib/guide.js";
import { screenGuidePage, viewedScreen } from "../../lib/guide.js";
import { legacyRedirect, parseRoute } from "../../router.js";
import { routeOwner } from "../route-registry.js";
import type { Route, RouteName } from "../routes.js";

export interface RouteExpectations {
  /** The owner the registry reports: the feature folder name, or `app` for the shell. */
  owner: string;
  /** The module's `screens`: each route it owns and its guide page. */
  module: { readonly screens: object };
  screens: Partial<Record<RouteName, GuidePage | null>>;
  /** An address as typed, the route it parses to, and where `legacyRedirect` sends it. */
  addresses: Array<[hash: string, route: Route, redirect?: string]>;
  /** An href helper's result, the address it must be, and the route it parses back to. */
  hrefs: Array<[built: string, expected: string, route: Route]>;
  /** An address, then the screen and guide page for a manager, then for a Member. */
  viewed: Array<
    [hash: string, manager: string, managerPage: GuidePage, member: string, memberPage: GuidePage]
  >;
}

export function describeRoutes(expected: RouteExpectations): void {
  describe(`${expected.owner} routes`, () => {
    it("owns its routes, each with its guide page", () => {
      expect({ ...expected.module.screens }).toEqual(expected.screens);
      for (const name of Object.keys(expected.screens))
        expect(routeOwner(name as RouteName), name).toBe(expected.owner);
    });

    for (const [hash, route, redirect] of expected.addresses)
      it(`parses ${JSON.stringify(hash)}${redirect ? ` and redirects it to ${redirect}` : ""}`, () => {
        expect(parseRoute(hash)).toEqual(route);
        expect(legacyRedirect(hash)).toBe(redirect);
      });

    it("builds hrefs that are current and parse back to their route", () => {
      for (const [built, href, route] of expected.hrefs) {
        expect(built).toBe(href);
        expect(parseRoute(built), built).toEqual(route);
        expect(legacyRedirect(built), built).toBeUndefined();
      }
    });

    for (const [hash, manager, managerPage, member, memberPage] of expected.viewed)
      it(`shows ${JSON.stringify(hash)} to each role with its guide page`, () => {
        const route = parseRoute(hash);
        expect(viewedScreen(route, { manager: true })).toBe(manager);
        expect(screenGuidePage(route, { manager: true })).toBe(managerPage);
        expect(viewedScreen(route, { manager: false })).toBe(member);
        expect(screenGuidePage(route, { manager: false })).toBe(memberPage);
      });
  });
}
