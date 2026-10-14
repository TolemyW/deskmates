// The signed-in UI of one tenant: its API, members and account clients, the providers every
// screen reads, and the shell.

import type { AuthenticatedSessionView, ProfileView, UserPreferences } from "@deskmates/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type AccountClient, createAccountClient } from "../api/account-client.js";
import { type ApiClient, createApiClient } from "../api/client.js";
import { setStreamTenant } from "../api/events.js";
import {
  type MembersClient,
  type SessionFlows,
  createMembersClient,
} from "../api/members-client.js";
import { DetailPaneLayout } from "../components/ui/detail-pane.js";
import type { useTheme } from "../lib/theme.js";
import { ActorDirectoryProvider } from "../state/actor-directory.js";
import { configureConversationDrafts } from "../state/conversation-drafts.js";
import { SessionRolesProvider, sessionRolesOf } from "../state/session-roles.js";
import { WorkspaceScopeProvider } from "../state/workspace-scope.js";
import { Shell } from "./shell.js";

/** How long after a password change a stray 401 is checked rather than taken as a sign-out. */
const ROTATION_GRACE_MS = 5_000;

export function AuthenticatedApp({
  session,
  release,
  flows,
  onExpired,
  onSwitchTenant,
  onPreferences,
  onProfile,
  onSessionRotated,
  onSignOut,
  theme,
}: {
  session: AuthenticatedSessionView;
  release: string | null;
  flows: SessionFlows;
  onExpired: () => void;
  onSwitchTenant: (tenantId: string) => void;
  /** The person's preferences after a change the Gateway stored. */
  onPreferences: (preferences: UserPreferences) => void;
  /** The person's profile after a change the Gateway stored. */
  onProfile: (profile: ProfileView) => void;
  /** The session a password change rotated to. */
  onSessionRotated: (view: AuthenticatedSessionView) => void;
  /** End this session, or every session of this person. */
  onSignOut: (everywhere: boolean) => void;
  theme: ReturnType<typeof useTheme>;
}) {
  const tenantId = session.tenant.id;
  // Streams opened by this tenant's screens name this tenant; set before any child subscribes.
  useMemo(() => setStreamTenant(tenantId), [tenantId]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The CSRF token is read per request through a ref, so the client stays stable across renders.
  const csrf = useRef(session.csrfToken);
  csrf.current = session.csrfToken;
  // A password change revokes this tab's old session, closing its streams, before the response
  // carrying the rotated cookie arrives (ADR-0022 P1). A 401 in that window is not a sign-out:
  // once the change settles the tab asks the Gateway, and expires only if it is signed out.
  const rotation = useRef<{ settled: Promise<void>; until: number } | undefined>(undefined);
  const unauthorized = useCallback(() => {
    if (!mounted.current) return;
    const pending = rotation.current;
    if (!pending || Date.now() > pending.until) {
      onExpired();
      return;
    }
    void pending.settled
      .then(() => flows.getSession(tenantId))
      .then(
        (view) => {
          if (mounted.current && !view.authenticated) onExpired();
        },
        () => {
          if (mounted.current) onExpired();
        },
      );
  }, [flows, onExpired, tenantId]);
  const api = useMemo<ApiClient>(
    () =>
      createApiClient({
        csrfToken: () => csrf.current,
        tenantId,
        onUnauthorized: unauthorized,
      }),
    [unauthorized, tenantId],
  );
  useEffect(
    () =>
      configureConversationDrafts(api, {
        userId: session.user.id,
        tenantId,
        authenticatedAt: session.session.authenticatedAt,
      }),
    [api, session.user.id, tenantId, session.session.authenticatedAt],
  );
  const members = useMemo<MembersClient>(
    () =>
      createMembersClient({
        csrfToken: () => csrf.current,
        tenantId,
        onUnauthorized: unauthorized,
      }),
    [unauthorized, tenantId],
  );
  const account = useMemo<AccountClient>(() => {
    const client = createAccountClient({
      csrfToken: () => csrf.current,
      tenantId,
      onUnauthorized: unauthorized,
    });
    return {
      ...client,
      changePassword: (currentPassword, newPassword) => {
        const call = client.changePassword(currentPassword, newPassword);
        const marker = {
          settled: call.then(
            () => undefined,
            () => undefined,
          ),
          until: Number.POSITIVE_INFINITY,
        };
        rotation.current = marker;
        void marker.settled.then(() => {
          marker.until = Date.now() + ROTATION_GRACE_MS;
        });
        return call;
      },
    };
  }, [unauthorized, tenantId]);
  // What this session's role may do; screens hide or disable the rest (issue #14).
  // Roles are per workspace (ADR-0022 amendment 6 W11); screens ask with the selected one.
  const roles = useMemo(() => sessionRolesOf(session), [session]);
  return (
    <SessionRolesProvider
      roles={roles}
      actorId={`user:${session.user.id}`}
      displayName={session.user.displayName}
    >
      <WorkspaceScopeProvider api={api}>
        <ActorDirectoryProvider
          members={members}
          allowed={session.tenant.role === "owner" || session.tenant.role === "admin"}
        >
          <DetailPaneLayout>
            <Shell
              api={api}
              members={members}
              account={account}
              flows={flows}
              session={session}
              release={release}
              onSwitchTenant={onSwitchTenant}
              onPreferences={onPreferences}
              onProfile={onProfile}
              onSessionRotated={onSessionRotated}
              onSignOut={onSignOut}
              theme={theme}
            />
          </DetailPaneLayout>
        </ActorDirectoryProvider>
      </WorkspaceScopeProvider>
    </SessionRolesProvider>
  );
}
