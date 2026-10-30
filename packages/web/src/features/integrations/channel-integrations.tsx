// Managing a chat channel connection of a single-account plugin (Connections, 2026-10-22): the
// admission notice, technical details and the one-connection card. The list and the connect
// flow are in `channels-tab.tsx` and `channel-setup.tsx`.

import {
  type ChannelConnection,
  type ChannelPluginManifest,
  type ChannelPluginManifestV2,
  type WorkspaceId,
  channelSenderAdmission,
} from "@deskmates/contracts";
import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { Blocklist } from "./channel-connections.js";
import { channelWebhookPath } from "./channel-guide.js";
import { channelConnectionState } from "./channel-state.js";

/** Per-viewer memory of a dismissed admission notice; storage may be unavailable. */
const ADMISSION_NOTICE_KEY = "deskmates.integrations.admissionNotice.";

function admissionNoticeDismissed(connectionId: string, changedAt: string): boolean {
  try {
    return window.localStorage.getItem(ADMISSION_NOTICE_KEY + connectionId) === changedAt;
  } catch {
    return false;
  }
}

function dismissAdmissionNotice(connectionId: string, changedAt: string): void {
  try {
    window.localStorage.setItem(ADMISSION_NOTICE_KEY + connectionId, changedAt);
  } catch {
    // The notice comes back next time; nothing else depends on it.
  }
}

/**
 * ADR-0017 amendment 3: a connection whose plugin changed from an allowlist to admitting every
 * sender says so once, to each Owner or Admin, until they dismiss it.
 */
export function AdmissionNotice({
  connection,
  channel,
}: {
  connection: ChannelConnection;
  channel: string;
}) {
  const t = useT();
  const changedAt = connection.admissionChangedAt;
  const [dismissed, setDismissed] = useState(() =>
    changedAt ? admissionNoticeDismissed(connection.id, changedAt) : true,
  );
  if (!changedAt || dismissed) return null;
  return (
    <div className="integration-notice">
      <p className="small">{t("integrations.channels.admissionChanged", { channel })}</p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          dismissAdmissionNotice(connection.id, changedAt);
          setDismissed(true);
        }}
      >
        {t("integrations.channels.admissionChangedDismiss")}
      </Button>
    </div>
  );
}

/** Technical diagnostics stay folded away; the card's own words say what to do. */
export function TechnicalDetails({ lines }: { lines: readonly string[] }) {
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

/**
 * Manage the one connection of a plugin without `multipleConnections` (WhatsApp, ADR-0047
 * amendment 1 A5): its state, QR, webhook path, test message, lifecycle and blocklist. Connecting
 * happens in `ChannelSetupDialog`.
 */
export function ChannelCard({
  api,
  workspaceId,
  plugin,
  connection,
  canConnect,
  onChanged,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  plugin: ChannelPluginManifest | ChannelPluginManifestV2;
  connection: ChannelConnection;
  canConnect: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [testTo, setTestTo] = useState("");
  const [testText, setTestText] = useState("Hi from Deskmates");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const state = channelConnectionState(connection.status.phase);
  // ADR-0047 decision 13 and amendment 1 A3: an ABI-2 plugin that admits by default offers the
  // connection's blocklist on this card too (WhatsApp, ADR-0017 amendment 3).
  const blocklist =
    canConnect &&
    connection.apiVersion === 2 &&
    plugin.apiVersion === 2 &&
    channelSenderAdmission(plugin).mode === "blocklist";

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

  return (
    <li className="integration-card adopted">
      {error ? <p role="alert">{error}</p> : null}
      <div className="stack">
        {canConnect ? (
          <AdmissionNotice connection={connection} channel={plugin.displayName} />
        ) : null}
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
        {state === "archived" ? (
          <p className="small">{t("integrations.channels.explain.archived")}</p>
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
          <TechnicalDetails
            lines={[
              t("integrations.channels.webhook", {
                path: channelWebhookPath(workspaceId, plugin.id),
              }),
            ]}
          />
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
        {/* A trashed workspace is read-only: its stopped connection offers no command. */}
        {state === "archived" ? null : (
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
        )}
        {blocklist && state !== "archived" ? (
          <Blocklist api={api} workspaceId={workspaceId} connectionId={connection.id} />
        ) : null}
        <TechnicalDetails lines={connection.status.message ? [connection.status.message] : []} />
      </div>
    </li>
  );
}
