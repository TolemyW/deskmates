import { TabNavigation } from "@deskmates/ui";
// Resources › Knowledge (issue #27): reviewed documents (the former Library) and the dated
// observations bots learned (the former Facts), as two tabs with their own addresses. Documents
// are published by a human and shared by the whole team (they are not stored per workspace);
// observations belong to the selected workspace, are written by bots with provenance and
// validity, and are never published into Documents by this page (ADR-0011).

import { BookOpen, History, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { NoWorkspace, ResourceHeading } from "../../components/resource-page.js";
import { useT } from "../../i18n/i18n-provider.js";
import { type KnowledgeTab, knowledgeHref } from "../../router.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { KnowledgeGovernance, type KnowledgeGovernanceApi } from "./knowledge-governance.js";
import { KnowledgePanel } from "./knowledge.js";
import { MemoryMaintenance, type MemoryMaintenanceApi } from "./memory-maintenance.js";
import { ObservationsPanel } from "./observations.js";

export function KnowledgePage({ api, tab }: { api: ApiClient; tab: KnowledgeTab }) {
  const t = useT();
  const scope = useWorkspaceScope(api);
  const workspace = scope.current;
  const governanceApi = "listKnowledgePage" in api ? (api as KnowledgeGovernanceApi) : undefined;
  const maintenanceApi =
    "listMemoryRevalidations" in api ? (api as MemoryMaintenanceApi) : undefined;
  // Mounted only while open, so the list page asks for nothing it does not show.
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  if (scope.loaded && !workspace) return <NoWorkspace scope={scope} />;

  const tabs: { key: KnowledgeTab; label: string; icon: React.ReactNode }[] = [
    { key: "documents", label: t("knowledgePage.tabs.documents"), icon: <BookOpen size={15} /> },
    {
      key: "observations",
      label: t("knowledgePage.tabs.observations"),
      icon: <Sparkles size={15} />,
    },
  ];

  return (
    <section className="workspace-screen resource-page knowledge-page page-container">
      <ResourceHeading
        title={t("knowledgePage.title")}
        context={t("knowledgePage.context", {
          name: workspace?.name ?? t("workspace.thisWorkspace"),
        })}
      />
      <TabNavigation
        label={t("knowledgePage.tabsLabel")}
        value={tab}
        items={tabs.map((item) => ({ ...item, href: knowledgeHref(item.key) }))}
      />

      {tab === "documents" ? (
        <div className="workspace-library">
          <div className="knowledge-screen embedded">
            <KnowledgePanel api={api} />
            {governanceApi ? (
              <details className="workspace-history">
                <summary>
                  <History size={16} aria-hidden="true" /> {t("knowledgeGovernance.maintenance")}
                </summary>
                <KnowledgeGovernance api={governanceApi} />
              </details>
            ) : null}
          </div>
        </div>
      ) : workspace ? (
        <div className="workspace-observations">
          <p className="muted small resource-intro">{t("knowledgePage.observations.intro")}</p>
          <ObservationsPanel key={workspace.id} api={api} workspaceId={workspace.id} />
          {maintenanceApi ? (
            <details
              className="workspace-history memory-maintenance-details"
              onToggle={(event) => setMaintenanceOpen(event.currentTarget.open)}
            >
              <summary>
                <History size={16} aria-hidden="true" /> {t("knowledgePage.maintenance")}
              </summary>
              {maintenanceOpen ? (
                <MemoryMaintenance
                  key={workspace.id}
                  api={maintenanceApi}
                  workspaceId={workspace.id}
                />
              ) : null}
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
