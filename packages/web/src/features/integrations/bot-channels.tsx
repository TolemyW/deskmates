// Where people can reach one bot from another chat app, for its profile's "At a glance" card
// (Connections redesign, 2026-10-22). Read-only; connecting and switching bots are on Connections.

import type { BotDefinition, ChannelConnection, WorkspaceId } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";
import { connectionsHref } from "./route.js";

export function BotChannels({ api, bot }: { api: ApiClient; bot: BotDefinition }) {
  const t = useT();
  const canRead = useCan("integrations.read", bot.workspaceId).allowed;
  const [rows, setRows] = useState<{ name: string; account?: string | undefined }[]>();
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    void Promise.all([
      api.getChannelCatalog(),
      api.listChannelConnections(bot.workspaceId as WorkspaceId),
    ])
      .then(([catalog, connections]) => {
        if (!live) return;
        const name = (connection: ChannelConnection) =>
          catalog.plugins.find((entry) => entry.manifest.id === connection.pluginId)?.manifest
            .displayName ?? connection.pluginId;
        setRows(
          connections
            .filter((connection) => connection.botId === bot.id)
            .map((connection) => ({
              name: name(connection),
              account: connection.identityLabel ?? connection.status.account,
            })),
        );
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [api, bot.id, bot.workspaceId, canRead]);
  if (!canRead || rows === undefined) return null;
  return (
    <>
      <dt>{t("integrations.botChannels.title")}</dt>
      <dd>
        {rows.length > 0
          ? rows.map((row) => (row.account ? `${row.name} ${row.account}` : row.name)).join(", ")
          : t("integrations.botChannels.none")}
        {" · "}
        <a href={connectionsHref("channels")}>{t("integrations.botChannels.manage")}</a>
      </dd>
    </>
  );
}
