// Detail › Network profiles (ADR-0027 amendment 1 decisions 12 and 13, owner-decided
// 2026-10-14): a workspace's Admins and Owners select the LAN profiles available there, set the
// open-internet switch and check one URL, without leaving the workspace page.

import { workspaceRoleAtLeast } from "@deskmates/contracts";
import { useT } from "../../i18n/i18n-provider.js";
import type { DetailSectionProps } from "../workspaces/detail-sections.js";
import { WorkspaceNetworkPanel } from "./workspace-network-panel.js";

export function NetworkProfilesSection({ api, entry }: DetailSectionProps) {
  const t = useT();
  if (entry.archivedAt || !workspaceRoleAtLeast(entry.myRole, "admin")) return null;
  return (
    <section
      className="card workspace-detail-section network-profiles-section"
      aria-labelledby="workspace-network-profiles-title"
    >
      <h3 id="workspace-network-profiles-title">{t("network.sectionTitle")}</h3>
      <p className="muted">{t("network.sectionIntro")}</p>
      <WorkspaceNetworkPanel api={api} workspaceId={entry.id} />
    </section>
  );
}
