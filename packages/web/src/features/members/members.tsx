import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@deskmates/ui";
import { Avatar, Pill, Select } from "@deskmates/ui";
// People of the selected workspace (ADR-0022 P4, amendment 6 W3, W4, W9): roles there, role
// changes and removal, and invitations with a one-time link. Every call names the workspace. The
// Gateway enforces every rule (an Admin manages Members and Guests and promotes to Admin; only an
// Owner demotes or removes an Admin or grants Owner; the last Owner and the protected root stay);
// this screen only offers what the signed-in role may take and shows the Gateway's refusal.

import {
  type InvitationView,
  PEOPLE_PAGE_SIZE,
  type SsoProviderView,
  type TenantMemberView,
  type TenantRole,
  mayTakeAction,
} from "@deskmates/contracts";
import { useCallback, useState } from "react";
import type { MembersClient } from "../../api/members-client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { NextAction, RoleNote, useWorkspaceRole } from "../../state/session-roles.js";
import { useOptionalWorkspaceScope, useWorkspaceForCalls } from "../../state/workspace-scope.js";
import { MemberOnboarding, invitationRecipient } from "./member-onboarding.js";

/** Roles and statuses as the lists show them, in the UI's language. */
export const ROLE_WORDS: Readonly<Record<TenantRole, MessageKey>> = {
  owner: "members.role.owner",
  admin: "members.role.admin",
  member: "members.role.member",
  guest: "members.role.guest",
};
const MEMBER_STATUS_WORDS: Readonly<Record<TenantMemberView["status"], MessageKey>> = {
  active: "members.status.active",
  removed: "members.status.removed",
};
const INVITATION_STATUS_WORDS: Readonly<Record<InvitationView["status"], MessageKey>> = {
  open: "members.invitation.status.open",
  accepted: "members.invitation.status.accepted",
  revoked: "members.invitation.status.revoked",
  expired: "members.invitation.status.expired",
};

export function MembersScreen({
  client,
  tenantRole,
  userId,
  ssoProviders,
  tenantName = "",
  workspaceId: workspaceIdProp,
}: {
  client: MembersClient;
  /** The signed-in person's highest role; the role in the selected workspace wins when known. */
  tenantRole: TenantRole;
  userId: string;
  /** Providers this tenant trusts, for SSO invitations. */
  ssoProviders: SsoProviderView[];
  /** The team people are added to, as the invitation panel names it. */
  tenantName?: string;
  /** The workspace whose people this shows; the selected workspace when absent. */
  workspaceId?: string;
}) {
  const [roleFilter, setRoleFilter] = useState<TenantRole | "all">("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  const selected = useOptionalWorkspaceScope()?.current;
  const forCalls = useWorkspaceForCalls();
  const workspaceId = workspaceIdProp ?? forCalls.workspaceId;
  // Under a provider that has not selected a workspace yet, wait rather than ask without one.
  const pending = workspaceIdProp === undefined && forCalls.pending;
  // The role in this workspace (ADR-0022 amendment 6 W11); the highest role outside a provider.
  const role = useWorkspaceRole(workspaceId) ?? tenantRole;
  const roles = { tenantRole: role, platformMaintainer: false };
  const canChangeRoles = mayTakeAction(roles, "people.changeRole");
  const canInviteAdmin = mayTakeAction(roles, "people.inviteAdmin");
  const canManageAdmins = mayTakeAction(roles, "people.manageAdmins");
  const inWorkspace = workspaceId === undefined ? {} : { workspaceId };

  // Both lists are offset pages of 25 (#113 slice M). The workspace and the role filter are the
  // scope: a change returns to the first page, and a late answer for an old scope is dropped.
  // Until a provider has selected a workspace nothing is asked.
  const scope = `${pending ? "pending" : (workspaceId ?? "only")}|${roleFilter}`;
  const memberPages = usePagedQuery<TenantMemberView>({
    scopeKey: `members|${scope}`,
    limit: PEOPLE_PAGE_SIZE,
    mode: "offset",
    historyKey: "members.people",
    fetchPage: async ({ offset, limit }) => {
      if (pending) return new Promise<never>(() => {});
      const page = await client.pageMembers(workspaceId, {
        offset,
        limit,
        ...(roleFilter === "all" ? {} : { role: roleFilter }),
      });
      return { items: page.members, total: page.total };
    },
  });
  const invitationPages = usePagedQuery<InvitationView>({
    scopeKey: `invitations|${pending ? "pending" : (workspaceId ?? "only")}`,
    limit: PEOPLE_PAGE_SIZE,
    mode: "offset",
    historyKey: "members.invitations",
    fetchPage: async ({ offset, limit }) => {
      if (pending) return new Promise<never>(() => {});
      const page = await client.pageInvitations(workspaceId, { offset, limit });
      return { items: page.invitations, total: page.total };
    },
  });
  const members = memberPages.items;
  const invitations = invitationPages.items;
  const loading = memberPages.loading;
  const loadFailed = memberPages.error !== undefined;
  const loadError = memberPages.error ?? invitationPages.error;
  const reload = useCallback(async () => {
    memberPages.reload();
    invitationPages.reload();
  }, [memberPages.reload, invitationPages.reload]);

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // An Owner changes anyone; an Admin changes Members and Guests (W3, W4). The protected root is
  // never changed or removed, by anyone.
  const canChange = (member: TenantMemberView): boolean =>
    member.protected !== true &&
    (canManageAdmins || (canChangeRoles && (member.role === "member" || member.role === "guest")));
  const canRemove = (member: TenantMemberView): boolean =>
    member.protected !== true && (canChange(member) || member.userId === userId);
  const roleOptions = [
    ...(canManageAdmins ? [{ value: "owner", label: t("members.roleOption.owner") }] : []),
    { value: "admin", label: t("members.roleOption.admin") },
    { value: "member", label: t("members.roleOption.member") },
    { value: "guest", label: t("members.roleOption.guest") },
  ];

  return (
    <section className="members-screen page page-container">
      <header className="costs-header">
        <div>
          <h1>{t("members.title")}</h1>
          <p>{t("members.intro")}</p>
          {selected && selected.id === workspaceId ? (
            <p className="muted small" data-testid="members-workspace">
              {t("members.workspace", { workspace: selected.name })}
            </p>
          ) : null}
          <RoleNote
            action="people.changeRole"
            does={t("members.roleNote.does")}
            allowed={canChangeRoles && canInviteAdmin}
          />
          <RoleNote
            action="people.manageAdmins"
            does={t("members.roleNote.admins")}
            allowed={canManageAdmins || !canChangeRoles}
          />
        </div>
      </header>
      {error || loadError !== undefined ? (
        <p role="alert" className="error">
          {error || errorMessage(loadError)}
        </p>
      ) : null}
      <section className="card" aria-label={t("members.list.label")}>
        <div className="members-list-heading">
          <h2>{t("members.list.title")}</h2>
          <Select
            aria-label={t("members.filter.role")}
            value={roleFilter}
            onValueChange={(value) => setRoleFilter(value as TenantRole | "all")}
            options={[
              { value: "all", label: t("members.filter.all") },
              { value: "owner", label: t("members.roleOption.owner") },
              { value: "admin", label: t("members.roleOption.admin") },
              { value: "member", label: t("members.roleOption.member") },
              { value: "guest", label: t("members.roleOption.guest") },
            ]}
          />
        </div>
        <Table className="members-table" aria-label={t("members.list.label")} aria-busy={loading}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("members.list.name")}</TableHead>
              <TableHead scope="col">{t("members.list.role")}</TableHead>
              <TableHead scope="col">{t("members.list.status")}</TableHead>
              <TableHead scope="col">{t("members.list.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="table-empty">
                  {loading ? (
                    t("members.list.loading")
                  ) : loadFailed ? (
                    <>
                      {t("members.list.loadFailed")}
                      <Button variant="ghost" onClick={() => void reload()}>
                        {t("members.list.retry")}
                      </Button>
                    </>
                  ) : (
                    t("members.list.empty")
                  )}
                </TableCell>
              </TableRow>
            ) : null}
            {members.map((member) => (
              <TableRow key={member.userId}>
                <TableCell>
                  <div className="member-identity">
                    <Avatar name={member.displayName} />
                    <div>
                      <span>{member.displayName}</span>
                      <small>
                        {member.loginName ?? t("members.list.ssoAccount")}
                        {member.userId === userId ? t("members.list.you") : ""}
                      </small>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {canChange(member) && member.status === "active" ? (
                    <Select
                      aria-label={t("members.list.roleOf", { name: member.displayName })}
                      value={member.role}
                      disabled={busy}
                      onValueChange={(value) =>
                        void act(() =>
                          client.updateMember(member.userId, {
                            role: value as TenantRole,
                            ...inWorkspace,
                          }),
                        )
                      }
                      options={roleOptions}
                    />
                  ) : (
                    <span title={member.protected ? t("members.list.protected") : undefined}>
                      {t(ROLE_WORDS[member.role])}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Pill tone={member.status === "active" ? "success" : "neutral"}>
                    {t(MEMBER_STATUS_WORDS[member.status])}
                  </Pill>
                </TableCell>
                <TableCell>
                  {member.status === "active" && canRemove(member) ? (
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          client.updateMember(member.userId, { status: "removed", ...inWorkspace }),
                        )
                      }
                    >
                      {member.userId === userId
                        ? t("members.list.leave")
                        : t("members.list.remove")}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <PageBar query={memberPages} label={t("members.list.pages")} />
      </section>
      <section className="card" aria-label={t("members.invite.label")}>
        <h2>{t("members.invite.title")}</h2>
        <MemberOnboarding
          client={client}
          tenantName={tenantName}
          canInviteAdmin={canInviteAdmin}
          workspaceId={workspaceId}
          ssoProviders={ssoProviders}
          busy={busy}
          onChanged={reload}
          hint={
            // From totals, not one page (#113 slice M): no invitation at all, and every person
            // of an unfiltered, complete first page is this one or removed.
            !loading &&
            !loadFailed &&
            roleFilter === "all" &&
            invitationPages.page?.total === 0 &&
            (memberPages.page?.total ?? Number.POSITIVE_INFINITY) <= members.length &&
            members.every((member) => member.userId === userId || member.status !== "active") ? (
              <>
                <p className="muted small">{t("members.invite.nobody")}</p>
                <NextAction
                  action="people.invite"
                  does={t("members.invite.next.does")}
                  how={t("members.invite.next.how")}
                  allowed={mayTakeAction(roles, "people.invite")}
                />
              </>
            ) : undefined
          }
        />
        <ul className="invitation-list">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span>
                {t("members.invitation.summary", {
                  target: invitationRecipient(invitation, t),
                  role: t(ROLE_WORDS[invitation.role]),
                  status: t(INVITATION_STATUS_WORDS[invitation.status]),
                })}
              </span>
              {invitation.status === "open" ? (
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => client.revokeInvitation(invitation.id, workspaceId))
                  }
                >
                  {t("members.invitation.revoke")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <PageBar query={invitationPages} label={t("members.invitation.pages")} />
      </section>
    </section>
  );
}
