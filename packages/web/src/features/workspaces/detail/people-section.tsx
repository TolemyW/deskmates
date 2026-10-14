// Detail › People: membership and roles are managed on the People page (#116), scoped to the
// selected workspace. This section selects the workspace and opens it; it never edits roles itself.

import { Button } from "../../../components/ui/button.js";
import { useT } from "../../../i18n/i18n-provider.js";
import { navigate } from "../../../router.js";
import { useCan } from "../../../state/session-roles.js";
import { useOptionalWorkspaceScope } from "../../../state/workspace-scope.js";
import { membersHref } from "../../members/route.js";
import type { DetailSectionProps } from "../detail-sections.js";

export function PeopleSection({ entry }: DetailSectionProps) {
  const t = useT();
  const scope = useOptionalWorkspaceScope();
  const can = useCan("people.manage", entry.id);
  if (entry.archivedAt) return null;
  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-people-title">
      <h3 id="workspace-people-title">{t("workspaceManage.people.title")}</h3>
      <p className="muted small">{t("workspaceManage.people.body")}</p>
      {can.allowed ? (
        <div className="form-actions">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              scope?.select(entry.id);
              navigate(membersHref());
            }}
          >
            {t("workspaceManage.people.open")}
          </Button>
        </div>
      ) : (
        <p className="muted small">{t("workspaceManage.people.denied")}</p>
      )}
    </section>
  );
}
