// The main navigation, built from the features' navigation entries (issue #53): three groups,
// each link placed by its feature's group and order.

import { useEffect, useRef } from "react";
import type { MessageKey } from "../i18n/catalogs.js";
import { useT } from "../i18n/i18n-provider.js";
import type { NavEntry, NavGroup, ShellContext } from "./feature.js";
import { navigationGroups } from "./features.js";
import type { Route, RouteRoles } from "./routes.js";

const GROUP_LABEL: Readonly<Record<NavGroup, MessageKey>> = {
  talk: "app.nav.group.talk",
  resources: "app.nav.group.resources",
  operate: "app.nav.group.operate",
};

/** The groups and their entries; the registry is fixed once the modules load. */
const GROUPS = navigationGroups();

const noBadge = (): number => 0;

export function Navigation({
  route,
  roles,
  ctx,
}: {
  /** The route in the address bar (not the one a role redirect shows). */
  route: Route;
  roles: RouteRoles;
  ctx: ShellContext;
}) {
  const t = useT();
  // On a short window the navigation scrolls inside its own region above the footer; keep the
  // current page's link in view there. `nearest` leaves a link that is already visible alone.
  const nav = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route change is the trigger.
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('a[aria-current="page"]')?.scrollIntoView?.({
      block: "nearest",
    });
  }, [route]);
  return (
    <nav ref={nav} aria-label={t("app.nav.main")}>
      {GROUPS.map(({ group, entries }) => (
        <div className="nav-group" key={group}>
          <span className="nav-group-label">{t(GROUP_LABEL[group])}</span>
          {entries
            .filter(({ nav }) => nav.visible?.(roles) ?? true)
            .map(({ folder, nav }) => (
              <NavLink key={folder} entry={nav} active={nav.active(route)} ctx={ctx} />
            ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * One link. It carries its own name: the icon-only rail (max-width 1100px in app.css) hides the
 * label span with display: none, which takes the span's text out of the accessibility tree.
 */
export function NavLink({
  entry,
  active,
  ctx,
}: { entry: NavEntry; active: boolean; ctx: ShellContext }) {
  const t = useT();
  // Each link always renders the same entry, so the hook order is stable.
  const useCount = entry.badge?.useCount ?? noBadge;
  const count = useCount(ctx);
  const label = t(entry.label);
  const name = entry.badge && count > 0 ? entry.badge.name(t, count) : label;
  return (
    <a
      href={entry.href()}
      className={active ? "active" : ""}
      aria-current={active ? "page" : undefined}
      aria-label={name}
      title={name}
    >
      {entry.icon}
      <span>{label}</span>
      {entry.badge && count > 0 ? (
        <span className="badge" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </a>
  );
}
