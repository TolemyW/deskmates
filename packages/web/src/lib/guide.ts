// Which page of the operator guide (docs/guide/, issue #22) explains which screen. The one Help
// entry opens the bundled manual (issue #28); its "This screen" names the page for the screen the
// shell was actually showing when Help was opened. Each feature's route module names the page for
// its routes (issue #53); `guide.test.ts` reads docs/guide/ and fails when a page named there
// does not exist.

import { routeGuidePages, shownRoute } from "../app/route-registry.js";
import type { Route, RouteName } from "../router.js";

/** The index page the manual opens on. */
export const GUIDE_INDEX = "README";

/** A topic page of docs/guide/, without its `.md`. */
export type GuidePage =
  | "getting-started"
  | "workspaces"
  | "bots"
  | "chats-and-groups"
  | "tasks"
  | "approvals"
  | "integrations-and-connectors"
  | "channels"
  | "costs"
  | "people-and-roles"
  | "using-deskmates-from-another-agent";

/** Every route that shows a screen of the signed-in UI; the invitation page stands apart. */
export type GuideScreen = Exclude<RouteName, "invite">;

/**
 * The guide page that explains each screen, from the feature route modules. A route module must
 * name a page (or null) for every route it owns, so a new route fails to compile until it has one.
 */
export const SCREEN_GUIDE_PAGES: Readonly<Record<GuideScreen, GuidePage>> = Object.fromEntries(
  routeGuidePages(),
) as Record<GuideScreen, GuidePage>;

/**
 * The screen the shell renders for a route, after the redirects it applies: People is the chats
 * screen for a Member, and the legacy `#/desktops` path renders the contacts list. The shell
 * renders through the same `shownRoute`, so the two cannot drift apart.
 */
export function viewedScreen(route: Route, roles: { manager: boolean }): GuideScreen {
  return shownRoute(route, roles).name as GuideScreen;
}

/** The guide page for the screen a route shows. */
export function screenGuidePage(route: Route, roles: { manager: boolean }): GuidePage {
  return SCREEN_GUIDE_PAGES[viewedScreen(route, roles)];
}
