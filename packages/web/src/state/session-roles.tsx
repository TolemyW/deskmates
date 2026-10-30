// What the signed-in session's role may do (issue #14). Screens ask `useCan(action)` and hide or
// disable what the role cannot take, and `RoleNote` says which role can. The table of actions
// and roles is `ROLE_ACTIONS` in contracts, checked against the Gateway's route policy; nothing
// here is a permission. The Gateway refuses whatever a screen offers wrongly.
//
// Without a provider (a screen rendered on its own, as in its tests) every action is offered and
// the Gateway's answer is the only check, which is how the screens behaved before.
//
// The words are the UI's language (issue #23): `roles.*` in the message catalog.

import {
  type ActionRole,
  type AuthenticatedSessionView,
  ROLE_ACTIONS,
  type RoleAction,
  type SessionRoles,
  type TenantRole,
  type Thread,
  isOwnSideChat,
  mayTakeAction,
  sessionRoleIn,
} from "@deskmates/contracts";
import { type ReactNode, createContext, useContext } from "react";
import type { MessageKey } from "../i18n/catalogs.js";
import { useT } from "../i18n/i18n-provider.js";

import { ActorDirectoryContext } from "./actor-directory.js";
import { type ActorIdentity, actorLabel } from "./actor-label.js";
import { useSelectedWorkspaceId } from "./workspace-scope.js";

/**
 * The role facts of a signed-in session (ADR-0022 amendment 6 W11): the highest role, the root,
 * and the role in each workspace, keyed by workspace id.
 */
export function sessionRolesOf(session: AuthenticatedSessionView): SessionRoles {
  return {
    tenantRole: session.tenant.role,
    platformMaintainer: session.platformMaintainer === true,
    ...(session.root === true ? { root: true } : {}),
    ...(session.workspaceRoles
      ? {
          workspaceRoles: Object.fromEntries(
            session.workspaceRoles.map((entry) => [entry.workspaceId, entry.role]),
          ),
        }
      : {}),
  };
}

const SessionIdentityContext = createContext<ActorIdentity | undefined>(undefined);

const SessionRolesContext = createContext<SessionRoles | undefined>(undefined);
/** Uses the session profile and an optional already-authorized, current directory snapshot. */
export function useActorLabel(): (actor: string) => string {
  const identity = useContext(SessionIdentityContext);
  const directory = useContext(ActorDirectoryContext);
  return (actor) => actorLabel(actor, identity, directory);
}

/** The session's actor label, `user:<id>`, for "is this my side chat" (ADR-0022 amendment 1). */
const SessionActorContext = createContext<string | undefined>(undefined);

export function SessionRolesProvider({
  roles,
  actorId,
  displayName,
  children,
}: {
  roles: SessionRoles;
  actorId?: string;
  displayName?: string;
  children: ReactNode;
}) {
  return (
    <SessionRolesContext.Provider value={roles}>
      <SessionActorContext.Provider value={actorId}>
        <SessionIdentityContext.Provider
          value={actorId && displayName ? { actorId, displayName } : undefined}
        >
          {children}
        </SessionIdentityContext.Provider>
      </SessionActorContext.Provider>
    </SessionRolesContext.Provider>
  );
}

/** The session's actor label (`user:<id>`), or undefined without a signed-in person. */
export function useSessionActor(): string | undefined {
  return useContext(SessionActorContext);
}

/** The thread facts the post and run checks read. */
type ThreadFacts = Pick<Thread, "kind" | "sideChatActor"> &
  Partial<Pick<Thread, "privateToUserId" | "workspaceId">>;

/**
 * The session's role in a workspace (the selected one unless `workspaceId` names another);
 * undefined without a provider, or without a role there.
 */
export function useWorkspaceRole(workspaceId?: string): TenantRole | undefined {
  const roles = useContext(SessionRolesContext);
  const selected = useSelectedWorkspaceId();
  return roles === undefined ? undefined : sessionRoleIn(roles, workspaceId ?? selected);
}

/**
 * Whether the session is a Guest in the workspace, the selected one unless named (ADR-0022
 * amendment 6 W6). False without a provider, where every action is offered.
 */
export function useIsGuest(workspaceId?: string): boolean {
  const provided = useContext(SessionRolesContext) !== undefined;
  const role = useWorkspaceRole(workspaceId);
  return provided && (role === undefined || role === "guest");
}

/**
 * Whether this session may post in `thread` (ADR-0022 amendment 6 W4 to W6): an Admin or Owner
 * anywhere; a Member in the workspace's shared `chat` threads and their own private chats, never
 * in a `bus` thread; a Guest only in their own private inquiry (amendment 7 S1). `memberCount`
 * is the thread's bot members.
 */
export function useCanPost(thread: ThreadFacts | undefined, _memberCount: number): Can {
  const can = useCan(
    thread?.kind === "bus" ? "thread.postBus" : "thread.post",
    thread?.workspaceId,
  );
  const ask = useCan("inquiry.ask", thread?.workspaceId);
  const actorId = useContext(SessionActorContext);
  const guest = useIsGuest(thread?.workspaceId);
  const ownInquiry =
    guest &&
    thread?.kind === "chat" &&
    thread.privateToUserId !== undefined &&
    `user:${thread.privateToUserId}` === actorId;
  return ownInquiry ? ask : can;
}

/**
 * Whether this session may take an action an Admin takes anywhere and a Member only in a
 * one-bot chat they opened or their own private chat (ADR-0022 amendments 1 and 6): cancelling
 * a run (A11), answering a continuation ask (A12). `thread` is the chat in question, if known.
 * A Guest takes none of them (W6). An explicit null workspace keeps authenticated
 * controls unavailable until the run workspace or thread has been resolved.
 */
export function useCanInOwnSideChat(
  action: "run.cancel" | "run.continue",
  thread: ThreadFacts | undefined,
  memberCount: number,
  workspaceId?: string | null,
): Can {
  const scope = thread?.workspaceId ?? workspaceId;
  const roles = useContext(SessionRolesContext);
  const can = useCan(action, scope ?? undefined);
  const actorId = useContext(SessionActorContext);
  const guest = useIsGuest(scope ?? undefined);
  const ownChat =
    !guest &&
    thread !== undefined &&
    actorId !== undefined &&
    (isOwnSideChat(thread, memberCount, actorId) ||
      (thread.privateToUserId !== undefined && `user:${thread.privateToUserId}` === actorId));
  return { ...can, allowed: (scope !== null || roles === undefined) && (can.allowed || ownChat) };
}

export interface Can {
  allowed: boolean;
  /** The role the action needs. */
  role: ActionRole;
  /** That role in words, in the UI's language: "an Admin or Owner". */
  who: string;
  /** The same words starting a sentence: "An Admin or Owner". */
  whoStart: string;
}

/** Each role in words, mid-sentence and starting one. */
const WHO: Readonly<Record<ActionRole, MessageKey>> = {
  platform: "roles.who.platform",
  root: "roles.who.root",
  guest: "roles.who.guest",
  owner: "roles.who.owner",
  admin: "roles.who.admin",
  member: "roles.who.member",
};
const WHO_START: Readonly<Record<ActionRole, MessageKey>> = {
  platform: "roles.whoStart.platform",
  root: "roles.whoStart.root",
  guest: "roles.whoStart.guest",
  owner: "roles.whoStart.owner",
  admin: "roles.whoStart.admin",
  member: "roles.whoStart.member",
};

/**
 * Whether this session may take the action in the selected workspace (or in `workspaceId` when
 * the screen shows another one's row), and who may when it may not (ADR-0022 amendment 6 W11).
 */
export function useCan(action: RoleAction, workspaceId?: string): Can {
  const roles = useContext(SessionRolesContext);
  const selected = useSelectedWorkspaceId();
  const t = useT();
  const role: ActionRole = ROLE_ACTIONS[action].role;
  return {
    allowed: roles === undefined || mayTakeAction(roles, action, workspaceId ?? selected),
    role,
    who: t(WHO[role]),
    whoStart: t(WHO_START[role]),
  };
}

/**
 * One line saying who can take an action this session cannot; nothing when it can.
 * `does` completes "Only <who> can …", e.g. "register a database", and is already in the UI's
 * language. `allowed` overrides the session's answer for a screen that is handed the role
 * directly.
 */
export function RoleNote({
  action,
  does,
  allowed,
}: {
  action: RoleAction;
  does: string;
  allowed?: boolean;
}) {
  const can = useCan(action);
  const t = useT();
  if (allowed ?? can.allowed) return null;
  return (
    <p className="muted small role-note" data-role={can.role}>
      {t("roles.note", { who: can.who, does })}
    </p>
  );
}

/**
 * What an empty list asks for next and who may do it (issue #22). `does` completes "Next: …",
 * e.g. "add a bot"; `how` names the control, e.g. "with New contact", and is left out when this
 * session cannot take the action. Both are already in the UI's language. `allowed` overrides the
 * session's answer like `RoleNote`.
 */
export function NextAction({
  action,
  does,
  how,
  allowed,
}: {
  action: RoleAction;
  does: string;
  how?: string;
  allowed?: boolean;
}) {
  const can = useCan(action);
  const t = useT();
  const text =
    (allowed ?? can.allowed)
      ? how
        ? t("roles.nextAction.allowedHow", { does, how, whoStart: can.whoStart })
        : t("roles.nextAction.allowed", { does, whoStart: can.whoStart })
      : t("roles.nextAction.ask", { who: can.who, does });
  return (
    <p className="muted small next-action" data-testid="next-action" data-role={can.role}>
      {text}
    </p>
  );
}
