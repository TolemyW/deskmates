// App shell: the sidebar (workspace switcher, the features' navigation, status, the use/tune view
// switch, Help and the signed-in identity), the role badge at the top right of the work area in
// the tune view (ADR-0022 amendment 7 S8), the work area showing the feature screen for the hash route, the detail
// drawer for drawer routes (a run), and the bundled manual. The shell names no feature: the
// screens, links and drawers come from `features.ts` (issue #53).

import type {
  AuthenticatedSessionView,
  ProfileView,
  TenantRole,
  UiLocale,
  UserPreferences,
} from "@deskmates/contracts";
import { ROLE_ACTIONS, mayTakeAction, sessionRoleIn } from "@deskmates/contracts";
import { ResizeHandle } from "@deskmates/ui";
import { CircleQuestionMark, Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountClient } from "../api/account-client.js";
import type { ApiClient } from "../api/client.js";
import { type ConnectionStatus, subscribeEvents } from "../api/events.js";
import type { MembersClient } from "../api/members-client.js";
import { OperatorManual } from "../components/operator-manual.js";
import { SignedInUser } from "../components/signed-in-user.js";
import { DetailPane, DetailPaneContent } from "../components/ui/detail-pane.js";
import { DialogTitle } from "../components/ui/dialog.js";
import { WorkspaceSwitcher } from "../features/workspaces/workspace-switcher.js";
import type { MessageKey } from "../i18n/catalogs.js";
import { useLocale, useT } from "../i18n/i18n-provider.js";
import { type GuidePage, screenGuidePage } from "../lib/guide.js";
import { InterfaceViewProvider, useInterfaceViewPreference } from "../lib/interface-view.js";
import type { useTheme } from "../lib/theme.js";
import { parseRoute, useHashLocation } from "../router.js";
import { useNavigationWidth } from "../state/navigation-width.js";
import { sessionRolesOf } from "../state/session-roles.js";
import { useWorkspaceScope } from "../state/workspace-scope.js";
import { BrowserHoldBanner } from "./browser-hold-banner.js";
import type { ShellContext } from "./feature.js";
import { drawerFeatures, featureFor } from "./features.js";
import { type FirstRunGuide, FirstRunProvider } from "./first-run-checklist.js";
import { ForbiddenPage, MissingPage } from "./missing-page.js";
import { Navigation } from "./navigation.js";
import { PreferencesMenu } from "./preferences-menu.js";
import { RoleBadge } from "./role-badge.js";
import { shownRoute } from "./route-registry.js";
import type { Route, RouteRoles } from "./routes.js";

/** A tenant role as the sidebar names it. */
const TENANT_ROLE: Readonly<Record<TenantRole, MessageKey>> = {
  owner: "app.tenantRole.owner",
  admin: "app.tenantRole.admin",
  member: "app.tenantRole.member",
  guest: "app.tenantRole.guest",
};

/** The features whose routes open in the drawer; fixed once the modules load. */
const DRAWERS = drawerFeatures();

/** Where a drawer opened by a fresh page load returns when it closes. */
const DRAWER_FALLBACK: { route: Route; hash: string } = {
  route: { name: "threads" },
  hash: "#/threads",
};

export function Shell({
  api,
  members,
  account,
  session,
  release,
  onPreferences,
  onProfile,
  onSessionRotated,
  onSignOut,
  theme,
}: {
  api: ApiClient;
  members: MembersClient;
  account: AccountClient;
  session: AuthenticatedSessionView;
  release: string | null;
  onPreferences: (preferences: UserPreferences) => void;
  onProfile: (profile: ProfileView) => void;
  onSessionRotated: (view: AuthenticatedSessionView) => void;
  onSignOut: (everywhere: boolean) => void;
  theme: ReturnType<typeof useTheme>;
}) {
  const scope = useWorkspaceScope(api);
  // The role in the selected workspace decides what the shell offers (ADR-0022 amendment 6 W11).
  const workspaceRole =
    sessionRoleIn(sessionRolesOf(session), scope.current?.id) ?? session.tenant.role;
  const manager = workspaceRole === "owner" || workspaceRole === "admin";
  const dismissed = session.preferences?.firstRunChecklistDismissed === true;
  const firstRun = useMemo<FirstRunGuide>(
    () => ({
      dismissed,
      dismiss: async () => {
        onPreferences(await members.updatePreferences({ firstRunChecklistDismissed: true }));
      },
      people: members,
      userId: session.user.id,
    }),
    [dismissed, members, onPreferences, session.user.id],
  );
  const t = useT();
  const locale = useLocale();
  const preferences = session.preferences;
  // A language applies at once and is then stored; the previous one returns if the Gateway
  // does not store it.
  const changeLocale = useCallback(
    async (next: UiLocale) => {
      const previous = preferences ?? {};
      onPreferences({ ...previous, locale: next });
      try {
        onPreferences(await members.updatePreferences({ locale: next }));
      } catch {
        onPreferences(previous);
      }
    },
    [members, onPreferences, preferences],
  );
  const [gatewayConnection, setGatewayConnection] = useState<ConnectionStatus>("connecting");
  const checking = useRef(false);
  const checkConnection = useCallback(() => {
    // EventSource hides HTTP status. Check once per connection failure through authenticated fetch.
    if (checking.current) return;
    checking.current = true;
    void api
      .getConfig()
      .catch(() => {
        // Only a 401 expires the session (in the client); outages keep drafts and allow SSE recovery.
      })
      .finally(() => {
        checking.current = false;
      });
  }, [api]);
  useEffect(
    () =>
      subscribeEvents({
        onEvent: () => {},
        onStatus: setGatewayConnection,
        onReconnect: checkConnection,
      }),
    [checkConnection],
  );
  const sessionRoles = sessionRolesOf(session);
  const selectedId = scope.current?.id;
  const roles: RouteRoles = {
    manager,
    can: (action) => mayTakeAction(sessionRoles, action, selectedId),
  };
  const drawerOpener = useRef<HTMLElement | null>(null);
  const { route: locationRoute, hash: locationHash } = useHashLocation();
  const locationFeature = featureFor(locationRoute);
  const requiredAction =
    locationFeature?.readAction ?? locationFeature?.nav?.visible?.requiredAction;
  const locationAccessDenied =
    requiredAction !== undefined && roles.can?.(requiredAction) === false;
  // A drawer route opens over the screen that was showing, which stays in the work area.
  const drawer = locationFeature?.drawer !== undefined && !locationAccessDenied;
  const background = useRef(
    drawer ? DRAWER_FALLBACK : { route: locationRoute, hash: locationHash },
  );
  if (!drawer) background.current = { route: locationRoute, hash: locationHash };
  const route = drawer ? background.current.route : locationRoute;
  // A hidden link stays hidden, while a typed address explains the role it needs (#20).
  const routed = shownRoute(route, roles);
  const shown: Route = routed;

  const [menuOpen, setMenuOpen] = useState(false);
  // The bundled manual (issue #28), open over the work area. It remembers the page for the screen
  // that was showing when Help was opened, after the shell's role redirects.
  const [manual, setManual] = useState<{
    screenPage: GuidePage;
    start?: { page: GuidePage; anchor?: string | undefined };
  } | null>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const closeManual = useCallback(() => {
    setManual(null);
    // The work area is inert while the manual is open; focus Help once it is interactive again.
    requestAnimationFrame(() => helpButton.current?.focus());
  }, []);
  // Close the mobile menu and the manual on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route change is the trigger.
  useEffect(() => {
    setMenuOpen(false);
    setManual(null);
  }, [route]);
  const sidebarWidth = useNavigationWidth();
  const { view, setView } = useInterfaceViewPreference();
  const ctx: ShellContext = {
    api,
    members,
    account,
    session,
    manager,
    locale,
    changeLocale: (next) => void changeLocale(next),
    theme,
    view,
    setView,
    onProfile,
    onSessionRotated,
    onSignOut,
    checkConnection,
    openGuide: (page, anchor) =>
      setManual({ screenPage: screenGuidePage(shown, roles), start: { page, anchor } }),
  };
  return (
    <InterfaceViewProvider view={view}>
      <div
        className="app"
        data-nav-compact={sidebarWidth.width < 180}
        style={{ "--sidebar-w": `${sidebarWidth.width}px` } as CSSProperties}
      >
        <header className={`sidebar${menuOpen ? " menu-open" : ""}`}>
          <ResizeHandle
            label={t("panel.resizeNavigation")}
            value={sidebarWidth.width}
            min={sidebarWidth.min}
            max={sidebarWidth.max}
            onChange={sidebarWidth.setWidth}
          />
          <div className="sidebar-heading">
            <WorkspaceSwitcher scope={scope} />
            <button
              type="button"
              className="icon-button sidebar-collapse"
              aria-label={t(sidebarWidth.compact ? "app.nav.expand" : "app.nav.collapse")}
              title={t(sidebarWidth.compact ? "app.nav.expand" : "app.nav.collapse")}
              onClick={sidebarWidth.toggle}
            >
              {sidebarWidth.compact ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
          <button
            type="button"
            className="icon-button mobile-nav-toggle"
            aria-label={menuOpen ? t("app.nav.closeMenu") : t("app.nav.openMenu")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <Navigation route={route} roles={roles} ctx={ctx} />
          {/* Navigation alone scrolls; identity, view and connection controls stay reachable. */}
          <div className="sidebar-footer">
            <div className="sidebar-status-row">
              <output
                className="workspace-health"
                aria-label={t(
                  gatewayConnection === "open"
                    ? "app.footer.connected"
                    : gatewayConnection === "connecting"
                      ? "app.footer.connecting"
                      : "app.footer.offline",
                )}
                title={t(
                  gatewayConnection === "open"
                    ? "app.footer.connected"
                    : gatewayConnection === "connecting"
                      ? "app.footer.connecting"
                      : "app.footer.offline",
                )}
              >
                <span className={`status-dot ${gatewayConnection}`} />{" "}
                <span className="connection-label">
                  {t(
                    gatewayConnection === "open"
                      ? "app.footer.connected"
                      : gatewayConnection === "connecting"
                        ? "app.footer.connecting"
                        : "app.footer.offline",
                  )}
                </span>
                {release ? (
                  <span
                    className="release-label"
                    aria-label={t("app.footer.runningRelease")}
                    title={t("app.footer.runningRelease")}
                  >
                    {release}
                  </span>
                ) : null}
              </output>
              <div className="sidebar-guide">
                <button
                  ref={helpButton}
                  type="button"
                  className={manual ? "active" : ""}
                  aria-label={t("app.footer.help")}
                  title={t("app.footer.help")}
                  aria-expanded={manual !== null}
                  aria-controls={manual ? "operator-manual" : undefined}
                  onClick={() => {
                    setMenuOpen(false);
                    if (manual) closeManual();
                    else setManual({ screenPage: screenGuidePage(shown, roles) });
                  }}
                >
                  <CircleQuestionMark size={16} aria-hidden="true" />
                  <span>{t("app.footer.help")}</span>
                </button>
              </div>
            </div>
            {/* The tune view adds the operations screens and every knob (use-and-tune-views.md). */}
            <PreferencesMenu
              locale={locale}
              onLocaleChange={ctx.changeLocale}
              theme={theme.preference}
              onThemeChange={theme.setPreference}
              view={view}
              onViewChange={setView}
            />
            <div className="sidebar-account-row">
              <SignedInUser
                name={session.user.displayName}
                description={`${t(TENANT_ROLE[workspaceRole])} · ${session.tenant.name}`}
                avatarUrl={session.user.avatarUrl}
                current={route.name === "account"}
              />
              {/* In the account row rather than a band of its own over every page. */}
              {view === "tune" ? <RoleBadge roles={sessionRoles} workspaceId={selectedId} /> : null}
            </div>
          </div>
        </header>
        {gatewayConnection === "reconnecting" ? (
          <output className="gateway-offline-banner">{t("app.offline.banner")}</output>
        ) : null}
        {/* The work area stays mounted under the manual, inert, so drafts and scroll survive. */}
        <main
          className="content"
          inert={manual !== null || undefined}
          onClickCapture={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            const link =
              event.target instanceof Element
                ? event.target.closest<HTMLAnchorElement>("a[href]")
                : null;
            const href = link?.getAttribute("href");
            if (link && href?.startsWith("#/") && featureFor(parseRoute(href))?.drawer) {
              drawerOpener.current = link;
            }
          }}
        >
          <BrowserHoldBanner api={api} workspaceId={scope.current?.id} />
          <FirstRunProvider guide={firstRun}>
            {shown.name === "notFound" ? (
              <MissingPage path={shown.path} />
            ) : locationAccessDenied && requiredAction ? (
              <ForbiddenPage role={ROLE_ACTIONS[requiredAction].role} />
            ) : (
              featureFor(shown)?.render(shown, ctx)
            )}
          </FirstRunProvider>
        </main>
        {DRAWERS.map(([folder, feature]) => {
          const open = featureFor(locationRoute) === feature && !locationAccessDenied;
          const labels = feature.drawer as NonNullable<typeof feature.drawer>;
          return (
            <DetailPane
              key={folder}
              open={open}
              onOpenChange={(next) => {
                if (!next) window.location.hash = background.current.hash;
              }}
            >
              <DetailPaneContent
                placement="right"
                className="detail-drawer"
                onOpenAutoFocus={() => {
                  // Responsive reparenting opens a new focus scope, not a new user action.
                  if (
                    !drawerOpener.current?.isConnected &&
                    document.activeElement instanceof HTMLElement &&
                    document.activeElement !== document.body
                  ) {
                    drawerOpener.current = document.activeElement;
                  }
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  const opener = drawerOpener.current;
                  drawerOpener.current = null;
                  if (opener?.isConnected && window.location.hash === background.current.hash) {
                    opener.focus();
                  }
                }}
                aria-describedby={undefined}
                closeLabel={t(labels.closeLabel)}
              >
                <DialogTitle className="sr-only">{t(labels.title)}</DialogTitle>
                <div className="detail-drawer-scroll">
                  {open ? feature.render(locationRoute, ctx) : null}
                </div>
              </DetailPaneContent>
            </DetailPane>
          );
        })}
        {manual ? (
          <OperatorManual
            id="operator-manual"
            screenPage={manual.screenPage}
            start={manual.start}
            runningRelease={release}
            onClose={closeManual}
          />
        ) : null}
      </div>
    </InterfaceViewProvider>
  );
}
