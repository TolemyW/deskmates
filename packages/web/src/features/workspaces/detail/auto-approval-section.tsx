// Detail › Automatic approval (ADR-0002 amendment 4 B1, ADR-0034 decision 4): the workspace's
// automatic-approval switch through `GET`/`PUT /api/workspaces/:id/auto-approval`. An Owner or
// Admin of the workspace changes it; everyone else reads it. Its body is the approvals feature's
// component, so further approval settings land there without touching this section.

import { useT } from "../../../i18n/i18n-provider.js";
import { AutoApprovalToggle } from "../../approvals/auto-approval-toggle.js";
import type { DetailSectionProps } from "../detail-sections.js";

export function AutoApprovalSection({ api, entry }: DetailSectionProps) {
  const t = useT();
  return (
    <section
      className="card workspace-detail-section"
      aria-labelledby="workspace-auto-approval-title"
    >
      <h3 id="workspace-auto-approval-title">{t("approvals.auto.title")}</h3>
      <AutoApprovalToggle
        key={entry.id}
        api={api}
        workspaceId={entry.id}
        readOnly={Boolean(entry.archivedAt)}
      />
    </section>
  );
}
