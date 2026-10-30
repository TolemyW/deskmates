// The main navigation, built from the features' navigation entries (issue #53): three groups,
// each link placed by its feature's group and order. In the use view the links a feature marks
// `audience: "tune"` are left out, and a group with no link left is not shown.

import { useEffect, useRef } from "react";
import type { MessageKey } from "../i18n/catalogs.js";
import { useT } from "../i18n/i18n-provider.js";
import {
  type ExternalNavEntry,
  type NavEntry,
  type NavGroup,
  type RouteNavEntry,
  type ShellContext,
  isCurrentEntry,
} from "./feature.js";
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
  const visibleGroups = GROUPS.map(({ group, entries }) => ({
    group,
    entries: entries.filter(
      ({ nav }) =>
        (nav.visible?.(roles) ?? true) && (nav.audience !== "tune" || ctx.view === "tune"),
    ),
  })).filter(({ entries }) => entries.length > 0);
  // On a short window the navigation scrolls inside its own region above the footer; keep the
  // current page's link in view there. `nearest` leaves a link that is already visible alone.
  const nav = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route change is the trigger.
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('a[aria-current="page"]')?.scrollIntoView?.({
      block: "nearest",
    });
  }, [route, ctx.view]);
  return (
    <nav ref={nav} aria-label={t("app.nav.main")}>
      {visibleGroups.map(({ group, entries }) => (
        <div className="nav-group" key={group}>
          <span className="nav-group-label">{t(GROUP_LABEL[group])}</span>
          {entries.map(({ folder, nav }) => (
            <NavLink key={folder} entry={nav} active={isCurrentEntry(nav, route)} ctx={ctx} />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** A navigation badge stays one compact token even when a broken cron creates thousands. */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * One link. It carries its own name: the explicit 64-pixel icon rail hides the
 * label span with display: none, which takes the span's text out of the accessibility tree.
 */
export function NavLink({
  entry,
  active,
  ctx,
}: { entry: NavEntry; active: boolean; ctx: ShellContext }) {
  // Each link always renders the same entry, so each kind's hooks run in a stable order.
  if (entry.external) return <ExternalNavLink entry={entry} ctx={ctx} />;
  return <RouteNavLink entry={entry} active={active} ctx={ctx} />;
}

function RouteNavLink({
  entry,
  active,
  ctx,
}: { entry: RouteNavEntry; active: boolean; ctx: ShellContext }) {
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
          {badgeText(count)}
        </span>
      ) : null}
    </a>
  );
}

/**
 * A link that leaves the operator UI (ADR-0046 decision 8): a new tab with no opener, hidden
 * while the feature does not know the address. It is never current and carries no badge.
 */
function ExternalNavLink({ entry, ctx }: { entry: ExternalNavEntry; ctx: ShellContext }) {
  const t = useT();
  const href = entry.external.useHref(ctx);
  if (href === null) return null;
  const label = t(entry.label);
  const name = t("app.nav.external", { label });
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={name} title={name}>
      {entry.icon}
      <span>{label}</span>
    </a>
  );
}
