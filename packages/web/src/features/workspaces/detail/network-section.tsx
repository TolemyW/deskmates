// Detail › Network policy: whether the workspace browses the open public internet or an allowlist
// (ADR-0020). The allowlist is edited where it always was, on the Computer page of the selected
// workspace; this section selects the workspace and goes there.

import { Globe, Lock } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useT } from "../../../i18n/i18n-provider.js";
import { computerHref, navigate } from "../../../router.js";
import { useOptionalWorkspaceScope } from "../../../state/workspace-scope.js";
import type { DetailSectionProps } from "../detail-sections.js";

export function NetworkSection({ entry }: DetailSectionProps) {
  const t = useT();
  const scope = useOptionalWorkspaceScope();
  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-network-title">
      <h3 id="workspace-network-title">{t("workspaceManage.network.title")}</h3>
      <p>
        {entry.openInternet ? (
          <>
            <Globe size={14} aria-hidden="true" /> {t("workspaceManage.network.open")}
          </>
        ) : (
          <>
            <Lock size={14} aria-hidden="true" /> {t("workspaceManage.network.locked")}
          </>
        )}
      </p>
      {entry.archivedAt ? null : (
        <div className="form-actions">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              scope?.select(entry.id);
              navigate(computerHref());
            }}
          >
            {t("workspaceManage.network.edit")}
          </Button>
        </div>
      )}
    </section>
  );
}
