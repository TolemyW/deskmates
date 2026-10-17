// App shell: the sidebar (workspace switcher, the features' navigation, status, Help and the
// signed-in identity), the role badge at the top right of the work area (ADR-0022 amendment 7
// S8), the work area showing the feature screen for the hash route, the detail
// drawer for drawer routes (a run), and the bundled manual. The shell names no feature: the
// screens, links and drawers come from `features.ts` (issue #53).

import type {
  AuthenticatedSessionView,
  ProfileView,
  TenantRole,
  UiLocale,
  UserPreferences,
} from "@deskmates/contracts";
import { mayTakeAction, sessionRoleIn } from "@deskmates/contracts";
import { ResizeHandle } from "@deskmates/ui";
import { CircleQuestionMark, Menu, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountClient } from "../api/account-client.js";
import type { ApiClient } from "../api/client.js";
import type { MembersClient, SessionFlows } from "../api/members-client.js";
import { OperatorManual } from "../components/operator-manual.js";
import { SignedInUser } from "../components/signed-in-user.js";
import { DetailPane, DetailPaneContent } from "../components/ui/detail-pane.js";
import { DialogTitle } from "../components/ui/dialog.js";
import { WorkspaceSwitcher } from "../features/workspaces/workspace-switcher.js";
import type { MessageKey } from "../i18n/catalogs.js";
import { useLocale, useT } from "../i18n/i18n-provider.js";
import { type GuidePage, screenGuidePage } from "../lib/guide.js";
import type { useTheme } from "../lib/theme.js";
import { useHashLocation } from "../router.js";
import { useNavigationWidth } from "../state/navigation-width.js";
import { sessionRolesOf } from "../state/session-roles.js";
import { useWorkspaceScope } from "../state/workspace-scope.js";
import type { ShellContext } from "./feature.js";
import { drawerFeatures, featureFor } from "./features.js";
import { type FirstRunGuide, FirstRunProvider } from "./first-run-checklist.js";
import { Navigation } from "./navigation.js";
import { RoleBadge } from "./role-badge.js";
import { shownRoute } from "./route-registry.js";
import type { Route, RouteRoles } from "./routes.js";
import { startSso } from "./start-sso.js";
import { TenantSwitcher } from "./tenant-switcher.js";

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
  flows,
  session,
  release,
  onSwitchTenant,
  onPreferences,
  onProfile,
  onSessionRotated,
  onSignOut,
  theme,
}: {
  api: ApiClient;
  members: MembersClient;
  account: AccountClient;
  flows: SessionFlows;
  session: AuthenticatedSessionView;
  release: string | null;
  onSwitchTenant: (tenantId: string) => void;
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
  const [switchError, setSwitchError] = useState<string>();
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
  const drawerOpener = useRef<HTMLElement | null>(null);
  const { route: locationRoute, hash: locationHash } = useHashLocation();
  // A drawer route opens over the screen that was showing, which stays in the work area.
  const drawer = featureFor(locationRoute)?.drawer !== undefined;
  const background = useRef(
    drawer ? DRAWER_FALLBACK : { route: locationRoute, hash: locationHash },
  );
  if (!drawer) background.current = { route: locationRoute, hash: locationHash };
  const route = drawer ? background.current.route : locationRoute;
  const sessionRoles = sessionRolesOf(session);
  const selectedId = scope.current?.id;
  const roles: RouteRoles = {
    manager,
    can: (action) => mayTakeAction(sessionRoles, action, selectedId),
  };
  // The screen the route shows after its owner's redirects (People is Chats for a Member), and
  // Chats for a screen whose link the role does not see (ADR-0022 amendment 7 S6).
  const routed = shownRoute(route, roles);
  const shown: Route =
    featureFor(routed)?.nav?.visible?.(roles) === false ? { name: "threads" } : routed;

  const [menuOpen, setMenuOpen] = useState(false);
  // The bundled manual (issue #28), open over the work area. It remembers the page for the screen
  // that was showing when Help was opened, after the shell's role redirects.
  const [manual, setManual] = useState<{ screenPage: GuidePage } | null>(null);
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
  const ctx: ShellContext = {
    api,
    members,
    account,
    session,
    manager,
    locale,
    changeLocale: (next) => void changeLocale(next),
    theme,
    onProfile,
    onSessionRotated,
    onSignOut,
    checkConnection,
  };
  return (
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
        <WorkspaceSwitcher scope={scope} />
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
        {/* Kept short so all eleven links fit above it at 1366x768; account settings,
            preferences and sign-out live on the page the identity link opens. */}
        <div className="sidebar-footer">
          <div className="sidebar-status-row">
            <div className="workspace-health">
              <span className="status-dot" /> {t("app.footer.connected")}
              {release ? (
                <span
                  className="release-label"
                  aria-label={t("app.footer.runningRelease")}
                  title={t("app.footer.runningRelease")}
                >
                  {release}
                </span>
              ) : null}
            </div>
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
          <div className="sidebar-account-row">
            <SignedInUser
              name={session.user.displayName}
              description={`${t(TENANT_ROLE[workspaceRole])} · ${session.tenant.name}`}
              avatarUrl={session.user.avatarUrl}
              current={route.name === "account"}
              canSwitchTeam={(session.tenants?.length ?? 0) > 1}
            >
              <TenantSwitcher
                current={session.tenant.id}
                tenants={session.tenants ?? []}
                onSwitch={onSwitchTenant}
                onStepUp={(tenant, provider) =>
                  void startSso(
                    flows,
                    provider,
                    {
                      purpose: "tenant_grant",
                      tenantId: tenant.id,
                      returnPath: `/?tenant=${encodeURIComponent(tenant.id)}`,
                    },
                    session.csrfToken,
                    setSwitchError,
                  )
                }
              />
              {switchError ? (
                <p role="alert" className="error">
                  {switchError}
                </p>
              ) : null}
            </SignedInUser>
          </div>
        </div>
      </header>
      {/* The work area stays mounted under the manual, inert, so drafts and scroll survive. */}
      <main className="content" inert={manual !== null || undefined}>
        <div className="shell-topbar">
          <RoleBadge roles={sessionRoles} workspaceId={selectedId} />
        </div>
        <FirstRunProvider guide={firstRun}>
          {featureFor(shown)?.render(shown, ctx)}
        </FirstRunProvider>
      </main>
      {DRAWERS.map(([folder, feature]) => {
        const open = featureFor(locationRoute) === feature;
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
                drawerOpener.current = document.activeElement as HTMLElement;
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                drawerOpener.current?.focus();
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
          runningRelease={release}
          onClose={closeManual}
        />
      ) : null}
    </div>
  );
}
