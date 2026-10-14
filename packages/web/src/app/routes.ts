// The hash routes of the operator UI as an open map (issue #53). There is no central list: each
// feature's `src/features/<feature>/route.ts` adds its routes to `RouteMap` with
// `declare module "../../app/routes.js"` and exports a `routes` module built by `defineRoutes`.
// `route-registry.ts` finds those modules with `import.meta.glob`, so a route module must not
// import a screen (screens import `router.ts`, which imports the registry).

import type { RoleAction } from "@deskmates/contracts";
import type { GuidePage } from "../lib/guide.js";

/**
 * Route name -> the route object `parseRoute` returns for it, whose `name` is the key. Feature
 * route modules augment it; `Route` stays a precise discriminated union of every entry.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by every feature's route.ts.
export interface RouteMap {}

export type RouteName = keyof RouteMap;

export type Route = RouteMap[RouteName];

/** The route object of one route name. */
export type RouteOf<N extends RouteName> = RouteMap[N];

/** What the shell knows about the signed-in person when it picks the screen a route shows. */
export interface RouteRoles {
  /** Owner or Admin of the selected workspace. */
  manager: boolean;
  /**
   * Whether the role in the selected workspace may take an action of `ROLE_ACTIONS` (ADR-0022
   * amendment 7 S6). Absent: every action is offered and the Gateway's answer decides.
   */
  can?: (action: RoleAction) => boolean;
}

/**
 * A navigation link shown to whoever may read its screen (ADR-0022 amendment 7 S6): `action` is
 * the screen's read action, checked against the route policy like every other action.
 */
export function readableBy(action: RoleAction): (roles: RouteRoles) => boolean {
  return (roles) => roles.can?.(action) ?? true;
}

/** Parses the path after a first segment (`rest` is the second segment, if any). */
export type SegmentParser = (rest: string | undefined) => Route | undefined;

/** The routes one feature (or the shell) owns: parsing, legacy redirects, guide pages. */
export interface RouteModule<N extends RouteName = RouteName> {
  /**
   * Every route name this module owns, with the docs/guide/ page that explains the screen it
   * shows; null for a route that is not a screen of the signed-in UI (the invitation page).
   */
  readonly screens: { readonly [K in N]: GuidePage | null };
  /**
   * First path segment -> its parser. A segment belongs to exactly one module; an older address
   * may parse to another module's route. A parser that returns undefined lands on home.
   */
  readonly segments: Readonly<Record<string, SegmentParser>>;
  /**
   * The current address of a route reached through an older or shortened hash; the router
   * rewrites the address bar when it differs. Undefined (or absent): the hash stays as typed.
   */
  canonicalHref?(route: RouteOf<N>): string | undefined;
  /** The route whose screen the shell shows instead, for example for a role. */
  shown?(route: RouteOf<N>, roles: RouteRoles): Route;
}

/** Declares a route module; the identity, there for inference of the owned route names. */
export function defineRoutes<N extends RouteName>(module: RouteModule<N>): RouteModule<N> {
  return module;
}
