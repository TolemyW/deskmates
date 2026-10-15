// Detail › Execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2, ADR-0034 decision 4):
// each counter's effective value and source through `GET`/`PUT /api/workspaces/:id/limits`.
// An Owner or Admin edits them (`limits.set`); everyone else reads them. The body is the limits
// feature's component; an archived workspace shows its limits without the editor.

import { LimitsSection } from "../../limits/limits-section.js";
import type { DetailSectionProps } from "../detail-sections.js";

export function WorkspaceLimitsSection({ api, entry }: DetailSectionProps) {
  return (
    <LimitsSection
      key={entry.id}
      api={api}
      workspaceId={entry.id}
      readOnly={Boolean(entry.archivedAt)}
    />
  );
}
