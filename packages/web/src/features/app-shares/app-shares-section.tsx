// Detail › Apps (ADR-0035): the workspace's published apps, the same panel as on the Files page.
// Every Member shares and stops sharing (owner-decided 2026-10-14); Guests cannot list apps, so
// the section says nothing to them. Opening it probes each active app once.

import { workspaceRoleAtLeast } from "@deskmates/contracts";
import { useT } from "../../i18n/i18n-provider.js";
import type { DetailSectionProps } from "../workspaces/detail-sections.js";
import { AppSharesPanel } from "./app-shares-panel.js";

export function AppSharesSection({ api, entry }: DetailSectionProps) {
  const t = useT();
  if (!workspaceRoleAtLeast(entry.myRole, "member")) return null;
  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-apps-title">
      <h3 id="workspace-apps-title">{t("appShares.title")}</h3>
      <p className="muted">{t("appShares.intro")}</p>
      <AppSharesPanel api={api} workspaceId={entry.id} />
    </section>
  );
}
