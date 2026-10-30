// Connections › Chat channels (owner, 2026-10-22: first tab). People reach the workspace's bots
// from another chat app. Connected accounts come first, each with the bot that answers and a
// plain-language state; then every channel this release can connect, with one Connect action
// that opens the guided setup. Channels are release-bundled plugins (ADR-0017 amendment 1,
// ADR-0047); everything shown comes from their manifests.

import type {
  BotDefinition,
  ChannelConnection,
  ChannelPluginManifest,
  ChannelPluginManifestV2,
  WorkspaceId,
} from "@deskmates/contracts";
import { BookOpen, ExternalLink, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage, formatRelative } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { ChannelCapabilities, ConnectionItem } from "./channel-connections.js";
import { channelGuideKey, connectionOpenUrl, useGuideText } from "./channel-guide.js";
import { AdmissionNotice, ChannelCard, TechnicalDetails } from "./channel-integrations.js";
import { ChannelSetupDialog } from "./channel-setup.js";
import {
  CHANNEL_STATE_LABELS,
  CHANNEL_STATE_TONES,
  channelConnectionState,
  channelStateExplanation,
} from "./channel-state.js";

type Plugin = ChannelPluginManifest | ChannelPluginManifestV2;

/** How often the tab reads connection states while it is open: QR codes and reconnects move. */
const REFRESH_MS = 3_000;

export function ChannelsTab({
  api,
  workspaceId,
  onCount,
  onOpenGuide,
  onOpenChats,
}: {
  api: ApiClient;
  workspaceId: string;
  /** The number of connected accounts, for the tab label. */
  onCount?: (count: number) => void;
  /** Open the manual's channels page, at a provider's section when given. */
  onOpenGuide: (anchor?: string) => void;
  onOpenChats: () => void;
}) {
  const t = useT();
  const text = useGuideText();
  const canConnect = useCan("integration.connect").allowed;
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [defaultBotId, setDefaultBotId] = useState<string>();
  const [failures, setFailures] = useState<{ id: string; message: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState<Plugin>();
  const [managing, setManaging] = useState<string>();
  // Dialogs here have no Radix trigger; focus returns to the button that opened them.
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => {
    if (!opener.current) return;
    event.preventDefault();
    opener.current.focus();
  };

  const readSequence = useRef(0);
  const pendingRead = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(
    async (quiet = false) => {
      if (!workspaceId || (quiet && pendingRead.current)) return;
      const sequence = ++readSequence.current;
      pendingRead.current = true;
      if (!quiet) {
        setRefreshing(true);
        setError("");
      }
      try {
        const [catalog, live, workspace] = await Promise.all([
          api.getChannelCatalog(),
          api.listChannelConnections(workspaceId as WorkspaceId),
          api.getWorkspace(workspaceId as WorkspaceId),
        ]);
        if (sequence !== readSequence.current) return;
        setPlugins(catalog.plugins.map((entry) => entry.manifest));
        setFailures(catalog.failures);
        setConnections(live);
        setBots(workspace.bots);
        setDefaultBotId(workspace.workspace.defaultBotId);
        setLoaded(true);
        setError("");
      } catch (reason) {
        if (sequence === readSequence.current && !quiet) setError(errorMessage(reason));
      } finally {
        if (sequence === readSequence.current) {
          pendingRead.current = false;
          setRefreshing(false);
        }
      }
    },
    [api, workspaceId],
  );

  const retry = useCallback(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setError("");
    setLoaded(false);
    setConnecting(undefined);
    setManaging(undefined);
    retry();
    const timer = window.setInterval(() => void load(true), REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      ++readSequence.current;
      pendingRead.current = false;
    };
  }, [load, retry]);

  const pluginOf = (id: string) => plugins.find((plugin) => plugin.id === id);
  // A saved connection whose plugin this release did not load: kept, but nothing can drive it.
  const stranded = connections.filter((connection) => !pluginOf(connection.pluginId));
  const listed = connections.filter((connection) => pluginOf(connection.pluginId));
  const unavailable = loaded && (plugins.length === 0 || stranded.length > 0);
  useEffect(() => {
    if (loaded) onCount?.(listed.length);
  }, [loaded, listed.length, onCount]);
  const managed = connections.find((connection) => connection.id === managing);
  const managedPlugin = managed ? pluginOf(managed.pluginId) : undefined;

  return (
    <div className="connections-tab" data-testid="channels-tab">
      <div className="connections-tab-intro">
        <p className="muted small">{t("integrations.channels.tabIntro")}</p>
        <button type="button" className="link-button small" onClick={() => onOpenGuide()}>
          <BookOpen size={13} aria-hidden="true" /> {t("integrations.channels.guide")}
        </button>
      </div>
      {!loaded && refreshing ? <output>{t("integrations.loading")}</output> : null}
      {error ? (
        <div className="integration-empty" role="alert">
          <p className="small">{t("integrations.channels.loadFailed")}</p>
          <Button type="button" variant="outline" onClick={retry} disabled={refreshing}>
            {t("integrations.channels.retry")}
          </Button>
          <TechnicalDetails lines={[error]} />
        </div>
      ) : null}
      {unavailable ? (
        <div className="integration-empty" data-testid="channels-unavailable">
          <p className="small">
            <strong>{t("integrations.channels.unavailable.title")}</strong>
          </p>
          <p className="muted small">{t("integrations.channels.unavailable.body")}</p>
          {stranded.length > 0 ? (
            <p className="muted small">{t("integrations.channels.unavailable.saved")}</p>
          ) : null}
          <Button type="button" variant="outline" onClick={retry} disabled={refreshing}>
            {t("integrations.channels.retry")}
          </Button>
          <TechnicalDetails
            lines={[
              ...failures.map((failure) => `${failure.id}: ${failure.message}`),
              ...stranded.map(
                (connection) =>
                  `${connection.pluginId}@${connection.pluginVersion}: ${connection.status.message ?? connection.status.phase}`,
              ),
            ]}
          />
        </div>
      ) : null}

      {listed.length > 0 ? (
        <section className="integration-group" aria-label={t("integrations.channels.connected")}>
          <div className="integration-group-head">
            <h2>{t("integrations.channels.connected")}</h2>
            <span className="muted small">
              {t("integrations.channels.v2.connectionCount", { count: listed.length })}
            </span>
          </div>
          <ul className="channel-connected-list">
            {listed.map((connection) => {
              const plugin = pluginOf(connection.pluginId) as Plugin;
              const method = plugin.methods.find((item) => item.id === connection.method);
              const state = channelConnectionState(connection.status.phase);
              const explanation = channelStateExplanation(state, connection.method);
              const open = connectionOpenUrl(method, connection);
              const bot = bots.find((item) => item.id === connection.botId);
              const account = connection.identityLabel ?? connection.status.account;
              return (
                <li key={connection.id} className="channel-connected-row">
                  <span className="integration-mark" aria-hidden="true">
                    <MessageCircle size={16} />
                  </span>
                  <div className="channel-connected-main">
                    <strong>
                      {plugin.displayName}
                      {account ? <span className="muted"> · {account}</span> : null}
                    </strong>
                    <span className="muted small">
                      {t("integrations.channels.v2.answeredBy", {
                        bot: bot?.name ?? connection.botId,
                      })}
                      {" · "}
                      {t("integrations.channels.updated", {
                        when: formatRelative(connection.updatedAt),
                      })}
                    </span>
                    {explanation ? <span className="small">{t(explanation)}</span> : null}
                  </div>
                  <Pill tone={CHANNEL_STATE_TONES[state]} dot={state === "connected"}>
                    {t(CHANNEL_STATE_LABELS[state])}
                  </Pill>
                  <div className="integration-card-actions">
                    {open && method?.open && state === "connected" ? (
                      <a
                        className="channel-open-link small"
                        href={open}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {text(
                          channelGuideKey(plugin.id, connection.method, "open"),
                          method.open.label,
                        )}{" "}
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t("integrations.channels.manageNamed", {
                        name: account ? `${plugin.displayName} ${account}` : plugin.displayName,
                      })}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        setManaging(connection.id);
                      }}
                    >
                      {t("integrations.channels.manage")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {plugins.length > 0 ? (
        <section className="integration-group" aria-label={t("integrations.channels.add")}>
          <div className="integration-group-head">
            <h2>
              {listed.length > 0
                ? t("integrations.channels.addAnother")
                : t("integrations.channels.add")}
            </h2>
          </div>
          <RoleNote action="integration.connect" does={t("integrations.channels.roleNote")} />
          {loaded && bots.length === 0 ? (
            <p className="muted small">{t("integrations.channels.explain.noBot")}</p>
          ) : null}
          <ul className="integration-grid">
            {plugins.map((plugin) => {
              const own = listed.filter((connection) => connection.pluginId === plugin.id);
              const single = plugin.apiVersion !== 2 || !plugin.multipleConnections;
              const full = single && own.length > 0;
              return (
                <li key={plugin.id} className="integration-card channel-provider-card">
                  <div className="integration-card-head">
                    <span className="integration-mark" aria-hidden="true">
                      {plugin.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="integration-title">
                      <strong>{plugin.displayName}</strong>
                      <span className="muted small">
                        {text(channelGuideKey(plugin.id, "description"), plugin.description)}
                      </span>
                    </div>
                  </div>
                  {plugin.apiVersion === 2 ? <ChannelCapabilities plugin={plugin} /> : null}
                  {own.length > 0 ? (
                    <Pill tone="success" dot>
                      {t("integrations.channels.v2.connectionCount", { count: own.length })}
                    </Pill>
                  ) : null}
                  <div className="integration-card-actions">
                    {canConnect && !full ? (
                      <Button
                        type="button"
                        variant={own.length > 0 ? "outline" : "default"}
                        disabled={bots.length === 0}
                        aria-label={t("integrations.channels.connectNamed", {
                          name: plugin.displayName,
                        })}
                        onClick={(event) => {
                          opener.current = event.currentTarget;
                          setConnecting(plugin);
                        }}
                      >
                        {own.length > 0
                          ? t("integrations.channels.v2.addAnother")
                          : t("integrations.channels.connect")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={t("integrations.channels.guideNamed", {
                        name: plugin.displayName,
                      })}
                      onClick={() => onOpenGuide(plugin.id)}
                    >
                      {t("integrations.channels.guideShort")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <ChannelSetupDialog
        api={api}
        workspaceId={workspaceId}
        plugin={connecting}
        bots={bots}
        defaultBotId={defaultBotId}
        connections={connections}
        onClose={() => setConnecting(undefined)}
        onChanged={load}
        onOpenChats={() => {
          setConnecting(undefined);
          onOpenChats();
        }}
        returnFocus={() => opener.current}
      />
      <Dialog
        open={managed !== undefined && managedPlugin !== undefined}
        onOpenChange={(next) => (!next ? setManaging(undefined) : undefined)}
      >
        <DialogContent
          className="channel-dialog max-w-xl overflow-y-auto"
          closeLabel={t("integrations.connect.close")}
          onCloseAutoFocus={restoreFocus}
        >
          {managed && managedPlugin ? (
            <>
              <DialogTitle className="pr-8 text-lg font-semibold">
                {managedPlugin.displayName}
              </DialogTitle>
              <DialogDescription className="muted small">
                {text(channelGuideKey(managedPlugin.id, "description"), managedPlugin.description)}
              </DialogDescription>
              <ul className="channel-dialog-body">
                {managedPlugin.apiVersion === 2 && managedPlugin.multipleConnections ? (
                  <>
                    {canConnect ? (
                      <AdmissionNotice connection={managed} channel={managedPlugin.displayName} />
                    ) : null}
                    <ConnectionItem
                      api={api}
                      workspaceId={workspaceId as WorkspaceId}
                      plugin={managedPlugin}
                      connection={managed}
                      bots={bots}
                      canConnect={canConnect}
                      onChanged={load}
                    />
                  </>
                ) : (
                  <ChannelCard
                    api={api}
                    workspaceId={workspaceId as WorkspaceId}
                    plugin={managedPlugin}
                    connection={managed}
                    canConnect={canConnect}
                    onChanged={load}
                  />
                )}
              </ul>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
