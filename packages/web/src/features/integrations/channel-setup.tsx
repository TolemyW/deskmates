// Connecting a chat channel in three steps (Connections redesign, 2026-10-22): who answers, what
// to do on the provider's side (ADR-0047 amendment 2), then connect and try it. Everything comes
// from the plugin's manifest; nothing here names a provider. Typed credentials live only in this
// dialog's state and are dropped when it closes or the connection is made.

import type {
  BotDefinition,
  BotId,
  ChannelConfigField,
  ChannelConnection,
  ChannelConnectionMethod,
  ChannelPluginManifest,
  ChannelPluginManifestV2,
  ChannelSetupStep,
  WorkspaceId,
} from "@deskmates/contracts";
import { Check, Copy, ExternalLink } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import {
  channelGuideKey,
  connectionOpenUrl,
  fillCopyValue,
  useGuideText,
} from "./channel-guide.js";
import { channelConnectionState } from "./channel-state.js";

type Plugin = ChannelPluginManifest | ChannelPluginManifestV2;
type Step = "answer" | "setup" | "try";
const STEPS: readonly Step[] = ["answer", "setup", "try"];

export function ChannelSetupDialog({
  api,
  workspaceId,
  plugin,
  bots,
  defaultBotId,
  connections,
  onClose,
  onChanged,
  onOpenChats,
  returnFocus,
}: {
  api: ApiClient;
  workspaceId: string;
  /** The control that opened the dialog; focus goes back to it on close. */
  returnFocus?: () => HTMLElement | null;
  /** The plugin being connected; undefined keeps the dialog closed. */
  plugin: Plugin | undefined;
  bots: BotDefinition[];
  defaultBotId?: string | undefined;
  /** The workspace's live connections, refreshed by the page; the new one is followed here. */
  connections: ChannelConnection[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpenChats: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={plugin !== undefined} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className="channel-setup-dialog max-w-xl overflow-y-auto"
        closeLabel={t("integrations.connect.close")}
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {plugin ? (
          <SetupFlow
            key={`${workspaceId}:${plugin.id}`}
            api={api}
            workspaceId={workspaceId}
            plugin={plugin}
            bots={bots}
            defaultBotId={defaultBotId}
            connections={connections}
            onClose={onClose}
            onChanged={onChanged}
            onOpenChats={onOpenChats}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SetupFlow({
  api,
  workspaceId,
  plugin,
  bots,
  defaultBotId,
  connections,
  onClose,
  onChanged,
  onOpenChats,
}: Omit<Parameters<typeof ChannelSetupDialog>[0], "plugin" | "returnFocus"> & { plugin: Plugin }) {
  const t = useT();
  const text = useGuideText();
  const [step, setStep] = useState<Step>("answer");
  const [methodId, setMethodId] = useState(plugin.methods[0]?.id ?? "");
  const preferred = bots.find((bot) => bot.id === defaultBotId) ?? bots[0];
  const [botId, setBotId] = useState(preferred?.id ?? "");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<ChannelConnection>();
  const method = plugin.methods.find((item) => item.id === methodId);

  useEffect(() => {
    if (!botId && preferred) setBotId(preferred.id);
  }, [botId, preferred]);

  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || !botId || !method) return;
    pending.current = true;
    setBusy(true);
    setError("");
    void api
      .connectChannel(workspaceId as WorkspaceId, plugin.id, {
        method: method.id,
        botId: botId as BotId,
        config,
      })
      .then(async (connection) => {
        // The credentials did their job; nothing typed outlives the request.
        setConfig({});
        setCreated(connection);
        setStep("try");
        await onChanged();
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };

  const live = created
    ? (connections.find((item) => item.id === created.id) ?? created)
    : undefined;
  const pluginText = (key: string, english: string) =>
    text(channelGuideKey(plugin.id, key), english);
  const methodText = (path: string[], english: string) =>
    text(channelGuideKey(plugin.id, methodId, ...path), english);

  return (
    <div className="channel-setup">
      <DialogTitle className="pr-8 text-lg font-semibold">
        {t("integrations.setup.title", { name: plugin.displayName })}
      </DialogTitle>
      <DialogDescription className="muted small">
        {pluginText("description", plugin.description)}
      </DialogDescription>
      <ol className="channel-setup-steps" aria-label={t("integrations.setup.progress")}>
        {STEPS.map((item, index) => (
          <li
            key={item}
            aria-current={item === step ? "step" : undefined}
            data-done={STEPS.indexOf(step) > index}
          >
            <span aria-hidden="true">{index + 1}</span> {t(`integrations.setup.step.${item}`)}
          </li>
        ))}
      </ol>

      {step === "answer" ? (
        <div className="stack">
          {bots.length === 0 ? (
            <p className="small">{t("integrations.channels.explain.noBot")}</p>
          ) : (
            <>
              <label>
                {t("integrations.setup.whoAnswers")}
                <select value={botId} onChange={(event) => setBotId(event.target.value)}>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.id === defaultBotId
                        ? t("integrations.setup.defaultBot", { name: bot.name })
                        : bot.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">{t("integrations.setup.oneBot")}</p>
            </>
          )}
          {plugin.methods.length > 1 ? (
            <fieldset className="channel-methods">
              <legend>{t("integrations.channels.method")}</legend>
              {plugin.methods.map((item) => (
                <label key={item.id} className="channel-method">
                  <input
                    type="radio"
                    name="channel-method"
                    value={item.id}
                    checked={item.id === methodId}
                    onChange={() => {
                      setMethodId(item.id);
                      setConfig({});
                    }}
                  />
                  <span>
                    <strong>
                      {text(channelGuideKey(plugin.id, item.id, "label"), item.label)}
                    </strong>
                    <span className="muted small">
                      {text(channelGuideKey(plugin.id, item.id, "description"), item.description)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("integrations.setup.cancel")}
            </Button>
            <Button type="button" disabled={!botId || !method} onClick={() => setStep("setup")}>
              {t("integrations.setup.next")}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "setup" && method ? (
        <form className="stack" onSubmit={connect} aria-label={t("integrations.setup.formLabel")}>
          <GuideSteps
            method={method}
            workspaceId={workspaceId}
            pluginId={plugin.id}
            methodText={methodText}
          />
          {method.fields.map((field) => (
            <FieldInput
              key={field.key}
              disabled={busy}
              field={field}
              label={methodText(["field", field.key], field.label)}
              help={field.help ? methodText(["field", field.key, "help"], field.help) : undefined}
              value={config[field.key] ?? ""}
              onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
          {error ? (
            <p role="alert" className="error small">
              {t("integrations.setup.failed", { error })}
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setStep("answer")}
            >
              {t("integrations.setup.back")}
            </Button>
            <Button type="submit" disabled={busy || !botId}>
              {busy ? t("integrations.setup.connecting") : t("integrations.channels.connect")}
            </Button>
          </div>
        </form>
      ) : null}

      {step === "try" && live ? (
        <TryIt
          plugin={plugin}
          method={plugin.methods.find((item) => item.id === live.method)}
          connection={live}
          bot={bots.find((bot) => bot.id === live.botId)}
          methodText={(path, english) =>
            text(channelGuideKey(plugin.id, live.method, ...path), english)
          }
          onClose={onClose}
          onOpenChats={onOpenChats}
        />
      ) : null}
    </div>
  );
}

function GuideSteps({
  method,
  workspaceId,
  pluginId,
  methodText,
}: {
  method: ChannelConnectionMethod;
  workspaceId: string;
  pluginId: string;
  methodText: (path: string[], english: string) => string;
}) {
  const t = useT();
  const steps = method.setup?.steps ?? [];
  if (steps.length === 0)
    return <p className="small">{methodText(["description"], method.description)}</p>;
  return (
    <ol className="channel-guide" aria-label={t("integrations.setup.guideLabel")}>
      {steps.map((item) => (
        <GuideStep
          key={item.id}
          step={item}
          text={methodText(["step", item.id], item.text)}
          linkLabel={item.link ? methodText(["step", item.id, "link"], item.link.label) : ""}
          copyLabel={item.copy ? methodText(["step", item.id, "copy"], item.copy.label) : ""}
          copyValue={item.copy ? fillCopyValue(item.copy.value, workspaceId, pluginId) : ""}
        />
      ))}
    </ol>
  );
}

function GuideStep({
  step,
  text,
  linkLabel,
  copyLabel,
  copyValue,
}: {
  step: ChannelSetupStep;
  text: string;
  linkLabel: string;
  copyLabel: string;
  copyValue: string;
}) {
  return (
    <li>
      <p className="small">{text}</p>
      {step.link ? (
        <a
          className="channel-guide-link small"
          href={step.link.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {linkLabel} <ExternalLink size={12} aria-hidden="true" />
        </a>
      ) : null}
      {step.copy ? <CopyValue label={copyLabel} value={copyValue} /> : null}
    </li>
  );
}

/** A value to paste on the provider: shown, selectable, and copied with one press. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const long = value.length > 120 || value.includes("\n");
  const copy = () => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  const body = <pre className="channel-copy-value">{value}</pre>;
  return (
    <div className="channel-copy">
      <div className="channel-copy-head">
        <span className="small">{label}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t("integrations.setup.copyNamed", { label })}
          onClick={copy}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{" "}
          {copied ? t("integrations.setup.copied") : t("integrations.setup.copy")}
        </Button>
      </div>
      {long ? (
        <details>
          <summary className="small">{t("integrations.setup.showValue")}</summary>
          {body}
        </details>
      ) : (
        body
      )}
    </div>
  );
}

function FieldInput({
  disabled,
  field,
  label,
  help,
  value,
  onChange,
}: {
  disabled: boolean;
  field: ChannelConfigField;
  label: string;
  help: string | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const helpId = `channel-field-help-${field.key}`;
  return (
    <div className="channel-field">
      <label>
        {label}
        <input
          disabled={disabled}
          type={field.secret ? "password" : "text"}
          required={field.required}
          autoComplete="off"
          placeholder={field.placeholder}
          value={value}
          aria-describedby={help ? helpId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {help ? (
        <span id={helpId} className="muted small">
          {help}
        </span>
      ) : null}
    </div>
  );
}

function TryIt({
  plugin,
  method,
  connection,
  bot,
  methodText,
  onClose,
  onOpenChats,
}: {
  plugin: Plugin;
  method: ChannelConnectionMethod | undefined;
  connection: ChannelConnection;
  bot: BotDefinition | undefined;
  methodText: (path: string[], english: string) => string;
  onClose: () => void;
  onOpenChats: () => void;
}) {
  const t = useT();
  const state = channelConnectionState(connection.status.phase);
  const open = connectionOpenUrl(method, connection);
  const account = connection.identityLabel ?? connection.status.account;
  const approvals = plugin.apiVersion === 2 ? plugin.capabilities.approvals === "available" : true;
  return (
    <div className="stack" aria-live="polite">
      {connection.status.message ? (
        <output className="small">{connection.status.message}</output>
      ) : null}
      {state === "qr" || (state === "connecting" && connection.status.qr) ? (
        connection.status.qr ? (
          <figure className="channel-qr">
            <img src={connection.status.qr} alt={t("integrations.channels.qrAlt")} />
            <figcaption className="muted small">{t("integrations.channels.scanQr")}</figcaption>
          </figure>
        ) : (
          <p className="muted small">{t("integrations.channels.explain.qrPending")}</p>
        )
      ) : null}
      {state === "connecting" && !connection.status.qr ? (
        <p className="muted small">{t("integrations.channels.explain.connecting")}</p>
      ) : null}
      {state === "connected" ? (
        <>
          <p>
            <strong>
              {account
                ? t("integrations.setup.connectedAs", { account })
                : t("integrations.setup.connected")}
            </strong>
          </p>
          <p className="muted small">
            {t("integrations.channels.v2.answeredBy", { bot: bot?.name ?? connection.botId })}
          </p>
          {open && method?.open ? (
            <a className="channel-open-link" href={open} target="_blank" rel="noopener noreferrer">
              {methodText(["open"], method.open.label)}{" "}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : null}
          <p className="muted small">
            {t("integrations.setup.whereChats", { name: plugin.displayName })}
          </p>
          {approvals ? <p className="muted small">{t("integrations.setup.approvals")}</p> : null}
        </>
      ) : null}
      {state === "relink" || state === "disconnected" ? (
        <p className="small" role="alert">
          {t(
            state === "relink"
              ? connection.method === "qr"
                ? "integrations.channels.explain.relink"
                : "integrations.channels.explain.reconnect"
              : "integrations.channels.explain.disconnected",
          )}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Button type="button" variant="outline" onClick={onClose}>
          {t("integrations.setup.done")}
        </Button>
        {state === "connected" ? (
          <Button type="button" onClick={onOpenChats}>
            {t("integrations.setup.openChats")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
