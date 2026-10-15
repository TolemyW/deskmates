// The bot fields that used to be fixed at creation (ADR-0043 decision 1) and the pause switch
// (ADR-0026 amendment 1). A rename moves the bot's directories and keeps its chats and its
// teammates' message allowlists pointing at it; the Gateway refuses it while the bot is running.
// Everything here reaches the bot from its next run.

import {
  type BotDefinition,
  EFFORT_LEVELS,
  type EffortLevel,
  type ThinkingConfig,
} from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import type { BotUpdate } from "./api.js";

type ThinkingChoice = "" | ThinkingConfig["type"];

function list(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function BotIdentity({
  api,
  bot,
  onSaved,
}: {
  api: ApiClient;
  bot: BotDefinition;
  onSaved: (bot: BotDefinition) => void;
}) {
  const [name, setName] = useState(bot.name);
  const [role, setRole] = useState(bot.role);
  const [connectors, setConnectors] = useState(bot.connectors.join(", "));
  const [allowlist, setAllowlist] = useState<string[]>([...bot.messageAllowlist]);
  const [effort, setEffort] = useState<EffortLevel | "">(bot.effort ?? "");
  const [thinking, setThinking] = useState<ThinkingChoice>(bot.thinking?.type ?? "");
  const [peers, setPeers] = useState<BotDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canConfigure = useCan("bot.configure").allowed;
  const t = useT();

  useEffect(() => {
    let active = true;
    api
      .listBots(bot.workspaceId)
      .then((bots) => active && setPeers(bots.filter((item) => item.id !== bot.id)))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, bot.id, bot.workspaceId]);

  const patch: BotUpdate = {};
  if (name.trim() !== bot.name) patch.name = name.trim();
  if (role.trim() !== bot.role) patch.role = role.trim();
  if (!same(list(connectors), bot.connectors)) patch.connectors = list(connectors);
  if (!same(allowlist, bot.messageAllowlist)) patch.messageAllowlist = allowlist;
  if (effort !== (bot.effort ?? "")) patch.effort = effort === "" ? null : effort;
  if (thinking !== (bot.thinking?.type ?? ""))
    patch.thinking = thinking === "" ? null : ({ type: thinking } as ThinkingConfig);
  const changed = Object.keys(patch).length > 0;

  const save = async (update: BotUpdate, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.updateBot(bot.id, update);
      onSaved(saved);
      setName(saved.name);
      setRole(saved.role);
      setConnectors(saved.connectors.join(", "));
      setAllowlist([...saved.messageAllowlist]);
      setNotice(done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Names the bot may `message_bot`: its workspace peers, plus any stored name no peer has now.
  const allowNames = [
    ...new Set([...peers.map((peer) => peer.name), ...allowlist, ...bot.messageAllowlist]),
  ];
  return (
    <section className="management-subsection bot-identity">
      <h3>{t("botIdentity.title")}</h3>
      <p className="muted small">{t("botIdentity.intro", { name: bot.name })}</p>
      <RoleNote action="bot.configure" does={t("botIdentity.roleNote")} />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      <div className="bot-pause">
        {bot.pausedAt ? (
          <p>
            <span className="pill warning">{t("botIdentity.paused")}</span>{" "}
            {t("botIdentity.pausedSince", {
              at: formatDateTime(bot.pausedAt),
              by: bot.pausedBy ?? "",
            })}
          </p>
        ) : (
          <p className="muted small">{t("botIdentity.pauseIntro", { name: bot.name })}</p>
        )}
        <Button
          type="button"
          disabled={busy || !canConfigure}
          onClick={() =>
            void save(
              { paused: !bot.pausedAt },
              bot.pausedAt ? t("botIdentity.resumed") : t("botIdentity.pausedNotice"),
            )
          }
        >
          {bot.pausedAt ? t("botIdentity.resume") : t("botIdentity.pause")}
        </Button>
      </div>
      <fieldset disabled={busy || !canConfigure}>
        <label>
          {t("botIdentity.name")}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {patch.name !== undefined ? (
          <p className="muted small">{t("botIdentity.renameHelp", { from: bot.name })}</p>
        ) : null}
        <label>
          {t("botIdentity.role")}
          <input value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
        <label>
          {t("botIdentity.connectors")}
          <input value={connectors} onChange={(event) => setConnectors(event.target.value)} />
        </label>
        <p className="muted small">{t("botIdentity.connectorsHelp")}</p>
        <fieldset className="bot-allowlist">
          <legend>{t("botIdentity.allowlist")}</legend>
          <p className="muted small">{t("botIdentity.allowlistHelp", { name: bot.name })}</p>
          {allowNames.length === 0 ? (
            <p className="muted small">{t("botIdentity.allowlistEmpty")}</p>
          ) : null}
          {allowNames.map((peer) => (
            <label key={peer} className="checkbox">
              <input
                type="checkbox"
                checked={allowlist.includes(peer)}
                onChange={(event) =>
                  setAllowlist((current) =>
                    event.target.checked
                      ? [...current, peer]
                      : current.filter((item) => item !== peer),
                  )
                }
              />
              {peer}
            </label>
          ))}
        </fieldset>
        <Select
          label={t("botIdentity.effort")}
          value={effort}
          onValueChange={(value) => setEffort(value as EffortLevel | "")}
          disabled={busy || !canConfigure}
          options={[
            { value: "", label: t("botIdentity.sdkDefault") },
            ...EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
          ]}
        />
        <Select
          label={t("botIdentity.thinking")}
          value={thinking}
          onValueChange={(value) => setThinking(value as ThinkingChoice)}
          disabled={busy || !canConfigure}
          options={[
            { value: "", label: t("botIdentity.sdkDefault") },
            { value: "adaptive", label: t("botIdentity.thinkingAdaptive") },
            { value: "enabled", label: t("botIdentity.thinkingEnabled") },
            { value: "disabled", label: t("botIdentity.thinkingDisabled") },
          ]}
        />
        <p className="muted small">{t("botIdentity.reasoningHelp")}</p>
        <Button
          type="button"
          variant="default"
          disabled={!changed}
          onClick={() => void save(patch, t("botIdentity.saved"))}
        >
          {t("botIdentity.save")}
        </Button>
      </fieldset>
    </section>
  );
}
