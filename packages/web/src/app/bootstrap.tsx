// The app: asks the Gateway whether this browser is signed in, then shows the sign-in screen,
// the invitation page or the signed-in UI of the selected tenant.

import type {
  AnonymousSessionView,
  AuthenticatedSessionView,
  ProfileView,
  UserPreferences,
} from "@deskmates/contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAuthClient } from "../api/auth-client.js";
import { createApiClient } from "../api/client.js";
import { createSessionFlows } from "../api/members-client.js";
import type { MessageKey } from "../i18n/catalogs.js";
import { I18nProvider } from "../i18n/i18n-provider.js";
import { currentI18n } from "../i18n/intl.js";
import { browserLanguages, resolveLocale } from "../i18n/locale.js";
import { useTheme } from "../lib/theme.js";
import { useHashRoute } from "../router.js";
import { clearStoredDrafts } from "../state/draft-storage.js";
import { AuthenticatedApp } from "./authenticated-app.js";
import { InviteScreen } from "./invite-screen.js";
import { PasswordChangeScreen } from "./password-change-screen.js";
import { CheckingSession, GatewayUnreachable } from "./session-status.js";
import { SignInScreen } from "./sign-in-screen.js";

type AuthState =
  | { phase: "loading" }
  | { phase: "unreachable" }
  | { phase: "anonymous"; view: AnonymousSessionView; notice?: string }
  | { phase: "signed-in"; view: AuthenticatedSessionView };

/** What the SSO callback put in the address bar, read once and then removed from it. */
function takeLandingParams(): { tenant?: string; ssoError?: string } {
  const params = new URLSearchParams(window.location.search);
  const tenant = params.get("tenant") ?? undefined;
  const ssoError = params.get("sso_error") ?? undefined;
  if (tenant !== undefined || ssoError !== undefined) {
    params.delete("tenant");
    params.delete("sso_error");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }
  return {
    ...(tenant ? { tenant } : {}),
    ...(ssoError ? { ssoError } : {}),
  };
}

const SSO_ERRORS: Readonly<Record<string, MessageKey>> = {
  no_account: "app.sso.error.noAccount",
  no_tenant: "app.sso.error.noTenant",
  not_linked: "app.sso.error.notLinked",
  not_allowed: "app.sso.error.notAllowed",
  identity_in_use: "app.sso.error.identityInUse",
  invitation_invalid: "app.sso.error.invitationInvalid",
  provider_unavailable: "app.sso.error.providerUnavailable",
};

function ssoErrorMessage(code: string): string {
  return currentI18n().t(SSO_ERRORS[code] ?? "app.sso.error.generic");
}

export function App() {
  // The theme applies to the sign-in screen too, so it is owned here and handed down.
  const theme = useTheme();
  const auth = useMemo(() => createAuthClient(), []);
  const flows = useMemo(() => createSessionFlows(), []);
  const route = useHashRoute();
  const landing = useMemo(() => takeLandingParams(), []);
  const [state, setState] = useState<AuthState>({ phase: "loading" });
  const [release, setRelease] = useState<string | null>(null);
  // The tenant this tab works in. Only a selector: the Gateway checks it on every request.
  const selectedTenant = useRef<string | undefined>(landing.tenant);
  // The browser keeps the HttpOnly session cookie across reloads and restarts; asking the
  // Gateway is how a reloaded page learns whether it is still signed in (ADR-0022 P1).
  const refresh = useCallback(
    async (notice?: string) => {
      try {
        const view = await flows.getSession(selectedTenant.current);
        if (view.authenticated) selectedTenant.current = view.tenant.id;
        else clearStoredDrafts();
        setState(
          view.authenticated
            ? { phase: "signed-in", view }
            : { phase: "anonymous", view, ...(notice ? { notice } : {}) },
        );
      } catch {
        setState({ phase: "unreachable" });
      }
    },
    [flows],
  );
  useEffect(() => {
    void refresh(landing.ssoError ? ssoErrorMessage(landing.ssoError) : undefined);
  }, [refresh, landing]);
  const switchTenant = useCallback(
    (tenantId: string) => {
      clearStoredDrafts();
      selectedTenant.current = tenantId;
      // Unmount the current tenant's screens first, so nothing of it stays on screen.
      setState({ phase: "loading" });
      void refresh();
    },
    [refresh],
  );
  const expire = useCallback(() => {
    clearStoredDrafts();
    // Unmount the signed-in UI first so every stream closes, then ask what the Gateway thinks.
    setState({ phase: "loading" });
    void refresh(currentI18n().t("app.session.ended"));
  }, [refresh]);
  // Account settings → Sign out. The signed-in UI unmounts first so every stream closes; the
  // Gateway then ends this session (or all of this person's sessions) and clears the cookie.
  const signOut = useCallback(
    async (everywhere: boolean) => {
      if (state.phase !== "signed-in") return;
      clearStoredDrafts();
      const csrf = state.view.csrfToken;
      setState({ phase: "loading" });
      try {
        await (everywhere ? auth.logoutAll(csrf) : auth.logout(csrf));
      } catch {
        // A session that is already gone is signed out; refresh shows what the Gateway thinks.
      }
      setRelease(null);
      await refresh();
    },
    [auth, refresh, state],
  );
  // A preference the Gateway stored becomes part of the session view this tab holds.
  const storePreferences = useCallback((preferences: UserPreferences) => {
    setState((current) =>
      current.phase === "signed-in"
        ? { phase: "signed-in", view: { ...current.view, preferences } }
        : current,
    );
  }, []);
  // A saved display name or photo shows at once wherever this person's identity appears.
  const storeProfile = useCallback((profile: ProfileView) => {
    setState((current) =>
      current.phase === "signed-in"
        ? {
            phase: "signed-in",
            view: {
              ...current.view,
              user: {
                ...current.view.user,
                displayName: profile.displayName,
                avatarUrl: profile.avatarUrl,
              },
            },
          }
        : current,
    );
  }, []);
  // A password change rotates the session (ADR-0022 P1): keep this tab's tenant and screens and
  // adopt the new CSRF token, held in memory only like the old one.
  const adoptRotatedSession = useCallback((rotated: AuthenticatedSessionView) => {
    setState((current) =>
      current.phase === "signed-in"
        ? {
            phase: "signed-in",
            view: {
              ...current.view,
              csrfToken: rotated.csrfToken,
              session: rotated.session,
              ...(rotated.account ? { account: rotated.account } : {}),
            },
          }
        : current,
    );
  }, []);

  // Until a default password is changed every `/api` route refuses (ADR-0022 amendment 6 W2).
  const signedIn = state.phase === "signed-in" && state.view.passwordChangeRequired !== true;
  // The person's stored language, else the browser's, else English (issue #23). The sign-in
  // screen has no person yet, so it follows the browser.
  const locale = resolveLocale(
    state.phase === "signed-in" ? state.view.preferences?.locale : undefined,
    browserLanguages(),
  );
  // Ask once per sign-in for the release label.
  useEffect(() => {
    if (!signedIn || release !== null) return;
    let live = true;
    createApiClient({
      onUnauthorized: () => live && expire(),
      ...(selectedTenant.current ? { tenantId: selectedTenant.current } : {}),
    })
      .getConfig()
      .then((config) => {
        if (live && typeof config.release === "string") setRelease(config.release);
      })
      .catch(() => {
        // 401 is handled by onUnauthorized; a Gateway outage leaves the label empty.
      });
    return () => {
      live = false;
    };
  }, [signedIn, release, expire]);
  return <I18nProvider locale={locale}>{renderPhase()}</I18nProvider>;

  function renderPhase(): ReactNode {
    if (state.phase === "loading") return <CheckingSession />;
    if (state.phase === "unreachable") {
      return (
        <GatewayUnreachable
          onRetry={() => {
            setState({ phase: "loading" });
            void refresh();
          }}
        />
      );
    }
    if (state.phase === "signed-in" && state.view.passwordChangeRequired === true) {
      return (
        <PasswordChangeScreen
          session={state.view}
          onChanged={() => {
            setState({ phase: "loading" });
            void refresh();
          }}
          onSignOut={() => void signOut(false)}
        />
      );
    }
    if (route.name === "invite") {
      return (
        <InviteScreen
          flows={flows}
          auth={auth}
          token={route.token}
          session={state.phase === "signed-in" ? state.view : undefined}
          loginCsrf={state.phase === "anonymous" ? state.view.loginCsrf : undefined}
          onSignedIn={(view) => {
            selectedTenant.current = view.tenant.id;
            window.location.hash = "#/threads";
            setState({ phase: "signed-in", view });
          }}
          onSessionStarted={(view) => {
            selectedTenant.current = view.tenant.id;
            setState({ phase: "signed-in", view });
          }}
          onJoined={(tenantId) => {
            window.location.hash = "#/threads";
            switchTenant(tenantId);
          }}
        />
      );
    }
    if (state.phase === "anonymous") {
      return (
        <SignInScreen
          flows={flows}
          auth={auth}
          view={state.view}
          notice={state.notice}
          onSignedIn={(view) => {
            selectedTenant.current = view.tenant.id;
            setState({ phase: "signed-in", view });
          }}
          onStale={() => void refresh()}
        />
      );
    }
    return (
      <AuthenticatedApp
        // A tenant switch remounts every screen: state, streams and in-flight requests of the
        // previous tenant are discarded rather than shown in the new one.
        key={`${state.view.user.id}:${state.view.tenant.id}`}
        session={state.view}
        release={release}
        flows={flows}
        onExpired={expire}
        onSwitchTenant={switchTenant}
        onPreferences={storePreferences}
        onProfile={storeProfile}
        onSessionRotated={adoptRotatedSession}
        onSignOut={(everywhere) => void signOut(everywhere)}
        theme={theme}
      />
    );
  }
}
