import { TabNavigation } from "@deskmates/ui";
// `#/connections/<tab>`: how people reach the workspace's bots and what the bots can use beyond
// the browser (Connections redesign, 2026-10-22). Chat channels come first (owner), then Apps;
// Databases are a Tune-view tab. Each tab loads its own data and reports its count for the label.

import { useCallback, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { AppsTab } from "./apps-tab.js";
import { ChannelsTab } from "./channels-tab.js";
import { DatabasesTab } from "./databases-tab.js";
import { CONNECTIONS_TABS, type ConnectionsTab, connectionsHref } from "./route.js";

export function ConnectionsScreen({
  api,
  tab,
  onOpenGuide,
  onOpenChats = () => {
    window.location.hash = "#/threads";
  },
}: {
  api: ApiClient;
  tab: ConnectionsTab;
  /** Open the manual's channels page, at a provider's section when given. */
  onOpenGuide: (anchor?: string) => void;
  onOpenChats?: () => void;
}) {
  const t = useT();
  const tune = useTuneView();
  const scope = useWorkspaceScope(api);
  const workspace = scope.current;
  const workspaceId = workspace?.id ?? "";
  const [workspaceCounts, setCounts] = useState<
    Record<string, Partial<Record<ConnectionsTab, number>>>
  >({});
  const counts = workspaceCounts[workspaceId] ?? {};
  const setCount = useCallback(
    (name: ConnectionsTab, count: number) =>
      setCounts((current) =>
        current[workspaceId]?.[name] === count
          ? current
          : {
              ...current,
              [workspaceId]: { ...current[workspaceId], [name]: count },
            },
      ),
    [workspaceId],
  );
  const channelsCount = useCallback((count: number) => setCount("channels", count), [setCount]);
  const appsCount = useCallback((count: number) => setCount("apps", count), [setCount]);
  const databasesCount = useCallback((count: number) => setCount("databases", count), [setCount]);
  // A hidden tab still opens from its address; the Tune view lists it.
  const tabs = CONNECTIONS_TABS.filter((item) => item !== "databases" || tune || tab === item);

  return (
    <section className="integrations-screen connections-screen page-container">
      <header className="integrations-header">
        <div>
          <h1>{t("integrations.title")}</h1>
          <p>
            {workspace
              ? t("integrations.intro.named", { workspace: workspace.name })
              : t("integrations.intro.unnamed")}
          </p>
        </div>
      </header>
      <TabNavigation
        label={t("integrations.tabs.label")}
        value={tab}
        items={tabs.map((item) => ({
          key: item,
          label: t(`integrations.tabs.${item}`),
          href: connectionsHref(item),
          suffix: counts[item] ? <span>{counts[item]}</span> : undefined,
        }))}
      />
      {!workspaceId ? (
        <p className="integration-empty muted small">{t("integrations.noWorkspace")}</p>
      ) : tab === "channels" ? (
        <ChannelsTab
          key={workspaceId}
          api={api}
          workspaceId={workspaceId}
          onCount={channelsCount}
          onOpenGuide={onOpenGuide}
          onOpenChats={onOpenChats}
        />
      ) : tab === "apps" ? (
        <AppsTab key={workspaceId} api={api} workspaceId={workspaceId} onCount={appsCount} />
      ) : (
        <DatabasesTab
          key={workspaceId}
          api={api}
          workspaceId={workspaceId}
          onCount={databasesCount}
        />
      )}
    </section>
  );
}
