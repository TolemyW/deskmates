// One account of an ABI-2 channel plugin (ADR-0047): for Owners and Admins the lifecycle,
// switching the answering bot (rebind), replacing credentials for the same account (relink) and
// the per-connection blocklist; and the plugin's capability matrix. Provider-neutral: everything
// comes from the manifest. Adding a connection is `ChannelSetupDialog`.

import {
  type BotDefinition,
  type BotId,
  CHANNEL_CAPABILITY_ROWS,
  CHANNEL_PHASE_ARCHIVED,
  type ChannelCapabilityState,
  type ChannelConnection,
  type ChannelConnectionMethod,
  type ChannelPluginManifestV2,
  type ChannelSenderBlock,
  type WorkspaceId,
} from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { channelGuideKey, useGuideText } from "./channel-guide.js";
import { ChannelMenu } from "./channel-menu.js";
import {
  CHANNEL_STATE_LABELS,
  CHANNEL_STATE_TONES,
  channelConnectionState,
  channelStateExplanation,
} from "./channel-state.js";

type CapabilityRow = (typeof CHANNEL_CAPABILITY_ROWS)[number];

const CAPABILITY_LABELS: Readonly<Record<CapabilityRow, MessageKey>> = {
  directMessages: "integrations.channels.v2.capability.directMessages",
  groups: "integrations.channels.v2.capability.groups",
  inboundImages: "integrations.channels.v2.capability.inboundImages",
  inboundOtherMedia: "integrations.channels.v2.capability.inboundOtherMedia",
  outboundReply: "integrations.channels.v2.capability.outboundReply",
  proactiveMessages: "integrations.channels.v2.capability.proactiveMessages",
  streaming: "integrations.channels.v2.capability.streaming",
  approvals: "integrations.channels.v2.capability.approvals",
  testMessage: "integrations.channels.v2.capability.testMessage",
};

const STATE_LABELS: Readonly<Record<ChannelCapabilityState, MessageKey>> = {
  available: "integrations.channels.v2.capabilityState.available",
  disabled: "integrations.channels.v2.capabilityState.disabled",
  unavailable: "integrations.channels.v2.capabilityState.unavailable",
};

const STATE_TONES: Readonly<Record<ChannelCapabilityState, "success" | "neutral" | "warning">> = {
  available: "success",
  disabled: "neutral",
  unavailable: "warning",
};

function FieldInputs({
  pluginId,
  method,
  values,
  onChange,
}: {
  pluginId: string;
  method: ChannelConnectionMethod | undefined;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const text = useGuideText();
  return (
    <>
      {method?.fields.map((field) => (
        <label key={field.key}>
          {text(channelGuideKey(pluginId, method.id, "field", field.key), field.label)}
          <input
            type={field.secret ? "password" : "text"}
            required={field.required}
            autoComplete="off"
            placeholder={field.placeholder}
            value={values[field.key] ?? ""}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        </label>
      ))}
    </>
  );
}

/** What a channel supports, from its manifest's capability matrix (ADR-0047 decision 12). */
export function ChannelCapabilities({ plugin }: { plugin: ChannelPluginManifestV2 }) {
  const t = useT();
  return (
    <details className="channel-capabilities small">
      <summary>{t("integrations.channels.v2.capabilities")}</summary>
      <ul>
        {CHANNEL_CAPABILITY_ROWS.map((row) => (
          <li key={row}>
            <span>{t(CAPABILITY_LABELS[row])}</span>{" "}
            <Pill tone={STATE_TONES[plugin.capabilities[row]]}>
              {t(STATE_LABELS[plugin.capabilities[row]])}
            </Pill>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One account of a multi-account plugin: its bot, lifecycle, credentials and blocklist. */
export function ConnectionItem({
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
  plugin: ChannelPluginManifestV2;
  connection: ChannelConnection;
  bots: BotDefinition[];
  canConnect: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rebindTo, setRebindTo] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const bound = bots.find((bot) => bot.id === connection.botId);
  const others = bots.filter((bot) => bot.id !== connection.botId);
  const method = plugin.methods.find((item) => item.id === connection.method);
  const label = connection.identityLabel ?? connection.identityKey ?? connection.id;
  const state = channelConnectionState(connection.status.phase);
  // The Gateway's own phase for a workspace in Trash (ADR-0017 amendment 1 P6): read-only.
  const archived = state === "archived";
  const explanation = channelStateExplanation(state, connection.method);

  const run = (operation: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    void operation()
      .then(async () => {
        if (done) setNotice(done);
        await onChanged();
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="channel-connection" data-testid={`channel-connection-${connection.id}`}>
      <div className="channel-connection-head">
        <strong>{t("integrations.channels.v2.identity", { label })}</strong>
        <Pill tone={CHANNEL_STATE_TONES[state]} dot={state === "connected"}>
          {t(CHANNEL_STATE_LABELS[state])}
        </Pill>
      </div>
      <p className="muted small">
        {t("integrations.channels.v2.answeredBy", { bot: bound?.name ?? connection.botId })}
      </p>
      {explanation ? <p className="small">{t(explanation)}</p> : null}
      {connection.status.message ? (
        <output className="small">{connection.status.message}</output>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output className="muted small">{notice}</output> : null}
      {canConnect && !archived ? (
        <>
          {connection.status.qr ? (
            <figure className="channel-qr">
              <img src={connection.status.qr} alt={t("integrations.channels.qrAlt")} />
            </figure>
          ) : null}
          <div className="integration-card-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(() => api.commandChannelConnection(workspaceId, connection.id, "reconnect"))
              }
            >
              {t("integrations.channels.reconnect")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                run(() => api.commandChannelConnection(workspaceId, connection.id, "disconnect"))
              }
            >
              {t("integrations.channels.disconnect")}
            </Button>
          </div>
          <details className="channel-connection-section">
            <summary>{t("integrations.channels.v2.rebind")}</summary>
            <p className="muted small">
              {t("integrations.channels.v2.rebindExplain", {
                bot: bound?.name ?? connection.botId,
              })}
            </p>
            {others.length === 0 ? (
              <p className="muted small">{t("integrations.channels.v2.rebindNoOther")}</p>
            ) : (
              <div className="inline-form">
                <label>
                  {t("integrations.channels.v2.rebindBot")}
                  <select value={rebindTo} onChange={(event) => setRebindTo(event.target.value)}>
                    <option value="">{t("integrations.channels.v2.rebindChoose")}</option>
                    {others.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  disabled={busy || !rebindTo}
                  onClick={() => {
                    const target = others.find((bot) => bot.id === rebindTo);
                    run(
                      () =>
                        api.rebindChannelConnection(workspaceId, connection.id, rebindTo as BotId),
                      t("integrations.channels.v2.rebindDone", { bot: target?.name ?? rebindTo }),
                    );
                  }}
                >
                  {t("integrations.channels.v2.rebindApply")}
                </Button>
              </div>
            )}
          </details>
          <details className="channel-connection-section">
            <summary>
              {t(
                method?.identity === "link"
                  ? "integrations.channels.relink"
                  : "integrations.channels.v2.relink",
              )}
            </summary>
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                run(
                  () =>
                    api.commandChannelConnection(workspaceId, connection.id, "relink", {
                      config: credentials,
                    }),
                  method?.identity === "link"
                    ? undefined
                    : t("integrations.channels.v2.relinkDone"),
                );
              }}
            >
              <p className="muted small">
                {t(
                  method?.identity === "link"
                    ? "integrations.channels.explain.relink"
                    : "integrations.channels.v2.relinkExplain",
                )}
              </p>
              <FieldInputs
                pluginId={plugin.id}
                method={method}
                values={credentials}
                onChange={(key, value) =>
                  setCredentials((current) => ({ ...current, [key]: value }))
                }
              />
              <div className="integration-card-actions">
                <Button type="submit" variant="outline" disabled={busy}>
                  {t(
                    method?.identity === "link"
                      ? "integrations.channels.relink"
                      : "integrations.channels.v2.relinkApply",
                  )}
                </Button>
              </div>
            </form>
          </details>
          {plugin.commandMenu ? (
            <ChannelMenu
              api={api}
              workspaceId={workspaceId}
              connectionId={connection.id}
              commands={plugin.commandMenu}
            />
          ) : null}
          <Blocklist api={api} workspaceId={workspaceId} connectionId={connection.id} />
        </>
      ) : null}
    </li>
  );
}

/** A connection's blocklist (ADR-0047 decision 13), also on the single-connection card. */
export function Blocklist({
  api,
  workspaceId,
  connectionId,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  connectionId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<ChannelSenderBlock[]>([]);
  const [senderId, setSenderId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api
      .listChannelSenderBlocks(workspaceId, connectionId)
      .then((list) => {
        if (live) setBlocks(list);
      })
      .catch((reason) => setError(errorMessage(reason)));
    return () => {
      live = false;
    };
  }, [api, workspaceId, connectionId, open]);

  const change = (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    void operation()
      .then(() => api.listChannelSenderBlocks(workspaceId, connectionId))
      .then(setBlocks)
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <details
      className="channel-connection-section"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>{t("integrations.channels.v2.blocklist")}</summary>
      <p className="muted small">{t("integrations.channels.v2.blocklistExplain")}</p>
      {error ? <p role="alert">{error}</p> : null}
      {blocks.length === 0 ? (
        <p className="muted small">{t("integrations.channels.v2.blocklistEmpty")}</p>
      ) : (
        <ul className="channel-blocklist">
          {blocks.map((block) => (
            <li key={block.senderId}>
              <code>{block.senderId}</code>
              {block.note ? <span className="muted small"> {block.note}</span> : null}{" "}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  change(() => api.unblockChannelSender(workspaceId, connectionId, block.senderId))
                }
              >
                {t("integrations.channels.v2.unblock")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!senderId.trim()) return;
          change(async () => {
            await api.blockChannelSender(workspaceId, connectionId, {
              senderId: senderId.trim(),
              ...(note.trim() ? { note: note.trim() } : {}),
            });
            setSenderId("");
            setNote("");
          });
        }}
      >
        <label>
          {t("integrations.channels.v2.blockSender")}
          <input value={senderId} onChange={(event) => setSenderId(event.target.value)} />
        </label>
        <label>
          {t("integrations.channels.v2.blockNote")}
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <Button type="submit" variant="outline" disabled={busy || !senderId.trim()}>
          {t("integrations.channels.v2.block")}
        </Button>
      </form>
    </details>
  );
}
