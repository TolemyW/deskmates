// What a feature contributes to the shell (issue #53): its navigation entry, how it renders its
// routes, and whether those routes open as a drawer over the screen that was showing. Each
// `src/features/<feature>/feature.tsx` exports `feature = defineFeature(routes, {...})`, where
// `routes` is its own route module; `features.ts` finds them with `import.meta.glob`.

import type {
  AuthenticatedSessionView,
  ProfileView,
  RoleAction,
  UiLocale,
} from "@deskmates/contracts";
import type { ReactNode } from "react";
import type { AccountClient } from "../api/account-client.js";
import type { ApiClient } from "../api/client.js";
import type { MembersClient } from "../api/members-client.js";
import type { MessageKey } from "../i18n/catalogs.js";
import type { I18n } from "../i18n/intl.js";
import type { GuidePage } from "../lib/guide.js";
import type { InterfaceView } from "../lib/interface-view.js";
import type { useTheme } from "../lib/theme.js";
import type {
  Route,
  RouteModule,
  RouteName,
  RouteOf,
  RouteRoles,
  RouteVisibility,
} from "./routes.js";

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
  /** The interface view in use: the everyday "use" view or the full "tune" view. */
  view: InterfaceView;
  /** Switch the view at once and store it in this browser. */
  setView: (next: InterfaceView) => void;
  /** The person's profile after a change the Gateway stored. */
  onProfile: (profile: ProfileView) => void;
  /** The session a password change rotated to. */
  onSessionRotated: (view: AuthenticatedSessionView) => void;
  /** End this session, or every session of this person. */
  onSignOut: (everywhere: boolean) => void;
  /** Check the session once after a stream lost its connection; only a 401 signs out. */
  checkConnection: () => void;
  /** Open the bundled manual at a page and, optionally, one of its headings. */
  openGuide: (page: GuidePage, anchor?: string) => void;
}

/** Formats a message of the active catalog. */
export type Translate = I18n["t"];

/** The sidebar sections, in the order they appear. */
export const NAV_GROUPS = ["talk", "resources", "operate"] as const;

export type NavGroup = (typeof NAV_GROUPS)[number];

interface NavEntryBase {
  group: NavGroup;
  /** Position inside the group, ascending. */
  order: number;
  icon: ReactNode;
  label: MessageKey;
  /** Who sees the link; everyone when absent. */
  visible?: RouteVisibility;
  /**
   * "tune" for an operations or tuning screen: the link shows only in the tune view
   * (docs/use-and-tune-views.md). The route stays reachable by its address in either view.
   */
  audience?: "tune";
  /** A count shown on the link, and the link's accessible name while it is above zero. */
  badge?: {
    /** A React hook, called on every render of the link. */
    useCount: (ctx: ShellContext) => number;
    name: (t: Translate, count: number) => string;
  };
}

/** A link to one of the feature's screens. */
export interface RouteNavEntry extends NavEntryBase {
  href: () => string;
  /** Whether the link is the current page for the route in the address bar. */
  active: (route: Route) => boolean;
  external?: undefined;
}

/**
 * A link to a page outside the operator UI, such as Analytics opening Grafana (ADR-0046 decision
 * 8). It opens in a new tab, is never the current page, and is hidden while its address is null.
 */
export interface ExternalNavEntry extends NavEntryBase {
  external: {
    /** A React hook, called on every render of the link: the address, or null to hide it. */
    useHref: (ctx: ShellContext) => string | null;
  };
  href?: undefined;
  active?: undefined;
}

/** A feature's link in the main navigation. */
export type NavEntry = RouteNavEntry | ExternalNavEntry;

/** Whether the entry is the current page for the route in the address bar. */
export function isCurrentEntry(entry: NavEntry, route: Route): boolean {
  return entry.external === undefined && entry.active(route);
}

/** A feature as the shell sees it. */
export interface Feature<N extends RouteName = RouteName> {
  /** The feature's route module; the shell renders this feature for each route it owns. */
  routes: RouteModule<N>;
  nav?: NavEntry;
  /** Read action for a screen with no nav entry, such as the run drawer. */
  readAction?: RoleAction;
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
