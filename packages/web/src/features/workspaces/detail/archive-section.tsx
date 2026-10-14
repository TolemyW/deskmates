// Detail › Archive: archiving keeps its existing confirmation on the Computer page (ADR-0026);
// restoring keeps Trash. This section only routes there, for the roles that may act.

import { Button, ButtonLink } from "../../../components/ui/button.js";
import { useT } from "../../../i18n/i18n-provider.js";
import { computerHref, navigate, trashHref } from "../../../router.js";
import { useCan } from "../../../state/session-roles.js";
import { useOptionalWorkspaceScope } from "../../../state/workspace-scope.js";
import type { DetailSectionProps } from "../detail-sections.js";

export function ArchiveSection({ entry }: DetailSectionProps) {
  const t = useT();
  const scope = useOptionalWorkspaceScope();
  const can = useCan("workspace.archive", entry.id);
  if (!can.allowed) return null;
  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-archive-title">
      <h3 id="workspace-archive-title">{t("workspaceManage.archive.title")}</h3>
      <p className="muted small">{t("workspaceManage.archive.body")}</p>
      <div className="form-actions">
        {entry.archivedAt ? (
          <ButtonLink href={trashHref()} variant="outline">
            {t("workspaceManage.archive.restore")}
          </ButtonLink>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              scope?.select(entry.id);
              navigate(computerHref());
            }}
          >
            {t("workspaceManage.archive.open")}
          </Button>
        )}
      </div>
    </section>
  );
}
