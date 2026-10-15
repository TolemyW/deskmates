// Detail › People (#116, ADR-0034 decision 9), in place: an Admin or Owner of the workspace gets
// the People page's own member list, role changes, removal and invitations for this workspace,
// with the workspace ID passed in, so every call names it and the Gateway's checks decide. A
// Member or Guest sees who manages people. The selected workspace never changes.

import { useT } from "../../../i18n/i18n-provider.js";
import { useCan } from "../../../state/session-roles.js";
import { MembersScreen } from "../../members/members.js";
import type { DetailSectionProps } from "../detail-sections.js";

export function PeopleSection({ entry, shell }: DetailSectionProps) {
  const t = useT();
  const can = useCan("people.manage", entry.id);
  if (entry.archivedAt) return null;
  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-people-title">
      <h3 id="workspace-people-title">{t("workspaceManage.people.title")}</h3>
      <p className="muted small">{t("workspaceManage.people.body")}</p>
      {!can.allowed ? (
        <p className="muted small">{t("workspaceManage.people.denied")}</p>
      ) : shell ? (
        <MembersScreen
          embedded
          client={shell.members}
          tenantRole={shell.session.tenant.role}
          tenantName={shell.session.tenant.name}
          userId={shell.session.user.id}
          ssoProviders={
            shell.session.tenants?.find((tenant) => tenant.id === shell.session.tenant.id)
              ?.ssoProviders ?? []
          }
          workspaceId={entry.id}
        />
      ) : null}
    </section>
  );
}
