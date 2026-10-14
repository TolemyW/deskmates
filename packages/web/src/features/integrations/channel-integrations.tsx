import type {
  BotDefinition,
  ChannelConfigField,
  ChannelConnection,
  ChannelPluginManifest,
  WorkspaceId,
} from "@deskmates/contracts";
import { MessageCircle } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";

const FIELD_LABELS: Readonly<Record<string, MessageKey>> = {
  allowedSenders: "integrations.channels.field.allowedSenders",
  proxyUrl: "integrations.channels.field.proxyUrl",
  phoneNumberId: "integrations.channels.field.phoneNumberId",
  graphApiVersion: "integrations.channels.field.graphApiVersion",
  accessToken: "integrations.channels.field.accessToken",
  appSecret: "integrations.channels.field.appSecret",
  verifyToken: "integrations.channels.field.verifyToken",
};

/**
 * What an operator needs to know about a connection, from the plugin's phase. The plugin's phase
 * vocabulary is provider-defined; anything unrecognised is treated as not reachable, so the page
 * never claims a connection it has not seen succeed (issue #43 UI QA).
 */
type ConnectionState = "connected" | "qr" | "connecting" | "relink" | "disconnected";

function connectionState(phase: string): ConnectionState {
  if (phase === "connected") return "connected";
  if (phase === "qr") return "qr";
  if (phase === "idle" || phase === "connecting" || phase === "reconnecting") return "connecting";
  if (phase === "logged_out") return "relink";
  return "disconnected";
}

const STATE_LABELS: Readonly<Record<ConnectionState, MessageKey>> = {
  connected: "integrations.channels.state.connected",
  qr: "integrations.channels.state.qr",
  connecting: "integrations.channels.state.connecting",
  relink: "integrations.channels.state.relink",
  disconnected: "integrations.channels.state.disconnected",
};

const STATE_TONES: Readonly<Record<ConnectionState, "success" | "warning" | "danger">> = {
  connected: "success",
  qr: "warning",
  connecting: "warning",
  relink: "danger",
  disconnected: "danger",
};

/** Technical diagnostics stay folded away; the card's own words say what to do. */
function TechnicalDetails({ lines }: { lines: readonly string[] }) {
  const t = useT();
  if (lines.length === 0) return null;
  return (
    <details className="channel-diagnostics small muted">
      <summary>{t("integrations.channels.technicalDetails")}</summary>
      <ul>
        {lines.map((line) => (
          <li key={line}>
            <code>{line}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ChannelIntegrations({ api, workspaceId }: { api: ApiClient; workspaceId: string }) {
  const t = useT();
  const canConnect = useCan("integration.connect").allowed;
  const [plugins, setPlugins] = useState<ChannelPluginManifest[]>([]);
  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [failures, setFailures] = useState<{ id: string; message: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!workspaceId) return;
    const [catalog, live, workspace] = await Promise.all([
      api.getChannelCatalog(),
      api.listChannelConnections(workspaceId as WorkspaceId),
      api.getWorkspace(workspaceId as WorkspaceId),
    ]);
    setPlugins(catalog.plugins.map((entry) => entry.manifest));
    setFailures(catalog.failures);
    setConnections(live);
    setBots(workspace.bots);
    setLoaded(true);
    setError("");
  }, [api, workspaceId]);

  const retry = useCallback(() => {
    void load().catch((reason) => setError(errorMessage(reason)));
  }, [load]);

  useEffect(() => {
    setError("");
    retry();
    const timer = window.setInterval(() => void load().catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [load, retry]);

  // A saved connection whose plugin this release did not load: kept, but nothing can drive it.
  const stranded = connections.filter(
    (connection) => !plugins.some((plugin) => plugin.id === connection.pluginId),
  );
  const unavailable = loaded && (plugins.length === 0 || stranded.length > 0);

  return (
    <section className="integration-group" aria-label={t("integrations.channels.label")}>
      <div className="integration-group-head">
        <h2>
          <MessageCircle size={16} /> {t("integrations.channels.title")}
        </h2>
        <span className="muted small">{t("integrations.channels.intro.product")}</span>
      </div>
      {error ? (
        <div className="integration-empty" role="alert">
          <p className="small">{t("integrations.channels.loadFailed")}</p>
          <Button type="button" variant="outline" onClick={retry}>
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
          <Button type="button" variant="outline" onClick={retry}>
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
      {plugins.length === 0 ? null : (
        <ul className="integration-grid">
          {plugins.map((plugin) => (
            <ChannelCard
              key={plugin.id}
              api={api}
              workspaceId={workspaceId as WorkspaceId}
              plugin={plugin}
              connection={connections.find((item) => item.pluginId === plugin.id)}
              bots={bots}
              canConnect={canConnect}
              onChanged={load}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChannelCard({
  api,
  workspaceId,
  plugin,
  connection,
  bots,
  canConnect,
  onChanged,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  plugin: ChannelPluginManifest;
  connection: ChannelConnection | undefined;
  bots: BotDefinition[];
  canConnect: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [method, setMethod] = useState(plugin.methods[0]?.id ?? "");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState("");
  const [testText, setTestText] = useState("Hi from Deskmates");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const selected = plugin.methods.find((candidate) => candidate.id === method);
  const state = connection ? connectionState(connection.status.phase) : undefined;

  useEffect(() => {
    if (!botId && bots[0]) setBotId(bots[0].id);
  }, [botId, bots]);

  /** Runs a lifecycle request; true only when the Gateway accepted it. */
  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    setTested(false);
    try {
      await operation();
      await onChanged();
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!botId || !selected) return;
    void run(() =>
      api.connectChannel(workspaceId, plugin.id, {
        method: selected.id,
        botId: botId as BotDefinition["id"],
        config,
      }),
    );
  };

  return (
    <li className={`integration-card${connection ? " adopted" : ""}`}>
      <div className="integration-card-head">
        <span className="integration-mark" aria-hidden="true">
          <MessageCircle size={16} />
        </span>
        <div className="integration-title">
          <strong>{plugin.displayName}</strong>
          <span className="muted small">{plugin.description}</span>
        </div>
        {state ? (
          <Pill tone={STATE_TONES[state]} dot={state === "connected"}>
            {t(STATE_LABELS[state])}
          </Pill>
        ) : (
          <Pill tone="neutral">{t("integrations.channels.state.notConnected")}</Pill>
        )}
      </div>

      {error ? <p role="alert">{error}</p> : null}
      {connection && state ? (
        <div className="stack">
          {connection.status.account ? (
            <p className="muted small">
              {t("integrations.channels.account", { account: connection.status.account })}
            </p>
          ) : null}
          {state === "connecting" ? (
            <p className="muted small">{t("integrations.channels.explain.connecting")}</p>
          ) : null}
          {state === "relink" ? (
            <p className="small">
              {t(
                connection.method === "qr"
                  ? "integrations.channels.explain.relink"
                  : "integrations.channels.explain.reconnect",
              )}
            </p>
          ) : null}
          {state === "disconnected" ? (
            <p className="small">{t("integrations.channels.explain.disconnected")}</p>
          ) : null}
          {state === "qr" && !connection.status.qr ? (
            <p className="muted small">{t("integrations.channels.explain.qrPending")}</p>
          ) : null}
          {connection.status.qr ? (
            <figure className="channel-qr">
              <img src={connection.status.qr} alt={t("integrations.channels.qrAlt")} />
              <figcaption className="muted small">{t("integrations.channels.scanQr")}</figcaption>
            </figure>
          ) : null}
          {connection.method === "cloud" ? (
            <p className="muted small">
              {t("integrations.channels.webhook", {
                path: `/api/channel-webhooks/${workspaceId}/${plugin.id}`,
              })}
            </p>
          ) : null}
          {state === "connected" ? (
            <div className="inline-form">
              <label>
                {t("integrations.channels.testRecipient")}
                <input value={testTo} onChange={(event) => setTestTo(event.target.value)} />
              </label>
              <label>
                {t("integrations.channels.testMessage")}
                <input value={testText} onChange={(event) => setTestText(event.target.value)} />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !canConnect || !testTo}
                onClick={() =>
                  void run(() =>
                    api.commandChannel(workspaceId, plugin.id, "test", {
                      to: testTo,
                      text: testText,
                    }),
                  ).then((ok) => setTested(ok))
                }
              >
                {t("integrations.channels.test")}
              </Button>
              {tested ? (
                <output className="muted small">{t("integrations.channels.testSent")}</output>
              ) : null}
            </div>
          ) : null}
          <div className="integration-card-actions">
            <Button
              type="button"
              variant={state === "disconnected" ? "default" : "outline"}
              disabled={busy || !canConnect}
              onClick={() =>
                void run(() => api.commandChannel(workspaceId, plugin.id, "reconnect"))
              }
            >
              {t(
                state === "disconnected"
                  ? "integrations.channels.retry"
                  : "integrations.channels.reconnect",
              )}
            </Button>
            {connection.method === "qr" ? (
              <Button
                type="button"
                variant={state === "relink" ? "default" : "outline"}
                disabled={busy || !canConnect}
                onClick={() => void run(() => api.commandChannel(workspaceId, plugin.id, "relink"))}
              >
                {t("integrations.channels.relink")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !canConnect}
              onClick={() =>
                void run(() => api.commandChannel(workspaceId, plugin.id, "disconnect"))
              }
            >
              {t("integrations.channels.disconnect")}
            </Button>
          </div>
          <TechnicalDetails lines={connection.status.message ? [connection.status.message] : []} />
        </div>
      ) : (
        <form className="stack" onSubmit={connect}>
          <p className="muted small">
            {t(
              bots.length === 0
                ? "integrations.channels.explain.noBot"
                : "integrations.channels.explain.notConnected",
            )}
          </p>
          <label>
            {t("integrations.channels.method")}
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              {plugin.methods.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("integrations.channels.defaultBot")}
            <select value={botId} onChange={(event) => setBotId(event.target.value)}>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          {selected?.fields.map((field) => (
            <ConfigInput
              key={field.key}
              field={field}
              value={config[field.key] ?? ""}
              onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
          <div className="integration-card-actions">
            <Button type="submit" disabled={busy || !canConnect || !botId || !method}>
              {t("integrations.channels.connect")}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function ConfigInput({
  field,
  value,
  onChange,
}: {
  field: ChannelConfigField;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const key = FIELD_LABELS[field.key];
  return (
    <label>
      {key ? t(key) : field.label}
      <input
        type={field.secret ? "password" : "text"}
        required={field.required}
        autoComplete="off"
        placeholder={field.placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
