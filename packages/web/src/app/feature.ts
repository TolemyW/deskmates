// What a feature contributes to the shell (issue #53): its navigation entry, how it renders its
// routes, and whether those routes open as a drawer over the screen that was showing. Each
// `src/features/<feature>/feature.tsx` exports `feature = defineFeature(routes, {...})`, where
// `routes` is its own route module; `features.ts` finds them with `import.meta.glob`.

import type { AuthenticatedSessionView, ProfileView, UiLocale } from "@deskmates/contracts";
import type { ReactNode } from "react";
import type { AccountClient } from "../api/account-client.js";
import type { ApiClient } from "../api/client.js";
import type { MembersClient } from "../api/members-client.js";
import type { MessageKey } from "../i18n/catalogs.js";
import type { I18n } from "../i18n/intl.js";
import type { useTheme } from "../lib/theme.js";
import type { Route, RouteModule, RouteName, RouteOf, RouteRoles } from "./routes.js";

/** What the shell hands every feature's screen: clients, the session and its callbacks. */
export interface ShellContext {
  api: ApiClient;
  members: MembersClient;
  account: AccountClient;
  session: AuthenticatedSessionView;
  /** Owner or Admin of the current tenant. */
  manager: boolean;
  /** The interface language in use. */
  locale: UiLocale;
  /** Apply a language at once and store it; the previous one returns if storing fails. */
  changeLocale: (next: UiLocale) => void;
  theme: ReturnType<typeof useTheme>;
  /** The person's profile after a change the Gateway stored. */
  onProfile: (profile: ProfileView) => void;
  /** The session a password change rotated to. */
  onSessionRotated: (view: AuthenticatedSessionView) => void;
  /** End this session, or every session of this person. */
  onSignOut: (everywhere: boolean) => void;
  /** Check the session once after a stream lost its connection; only a 401 signs out. */
  checkConnection: () => void;
}

/** Formats a message of the active catalog. */
export type Translate = I18n["t"];

/** The sidebar sections, in the order they appear. */
export const NAV_GROUPS = ["talk", "resources", "operate"] as const;

export type NavGroup = (typeof NAV_GROUPS)[number];

/** A feature's link in the main navigation. */
export interface NavEntry {
  group: NavGroup;
  /** Position inside the group, ascending. */
  order: number;
  icon: ReactNode;
  label: MessageKey;
  href: () => string;
  /** Whether the link is the current page for the route in the address bar. */
  active: (route: Route) => boolean;
  /** Who sees the link; everyone when absent. */
  visible?: (roles: RouteRoles) => boolean;
  /** A count shown on the link, and the link's accessible name while it is above zero. */
  badge?: {
    /** A React hook, called on every render of the link. */
    useCount: (ctx: ShellContext) => number;
    name: (t: Translate, count: number) => string;
  };
}

/** A feature as the shell sees it. */
export interface Feature<N extends RouteName = RouteName> {
  /** The feature's route module; the shell renders this feature for each route it owns. */
  routes: RouteModule<N>;
  nav?: NavEntry;
  /**
   * Its routes open in the detail drawer over the screen that was showing, rather than in the
   * work area; `title` names the drawer for screen readers, `closeLabel` its close button.
   */
  drawer?: { title: MessageKey; closeLabel: MessageKey };
  /** The screen for one of its routes, after the route module's `shown` redirect. */
  render(route: RouteOf<N>, ctx: ShellContext): ReactNode;
}

/** Declares a feature; `render` is typed by the routes its route module owns. */
export function defineFeature<N extends RouteName>(
  routes: RouteModule<N>,
  feature: Omit<Feature<N>, "routes">,
): Feature<N> {
  return { routes, ...feature };
}
