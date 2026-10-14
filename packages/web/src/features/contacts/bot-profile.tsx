// A bot's profile: what it is doing (its activity feed and desktop), what it knows, and how it
// is configured. Memory follows its owner here: the bot's own experience and the operator's
// notes live on the profile, workspace facts on the workspace page and task notes on the chat.

import type { BotDefinition, OperatorConfig, Workspace } from "@deskmates/contracts";
import { Activity, MessageSquare, Pencil, Settings2, Sparkles, StickyNote } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import { RUN_STATUS_LABEL, RunStatusPill } from "../../components/ui/pill.js";
import { errorMessage, formatDateTime, formatRelative } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";
import { DesktopCard } from "../computer/desktop-rail.js";
import { MemoryPanel } from "../knowledge/knowledge.js";
import { LearnedMemoryScreen } from "../knowledge/learned-memory.js";
import { useRunFeed } from "../runs/run-feed.js";
import { AvatarDialog } from "./avatar-picker.js";
import { BotActivity } from "./bot-activity.js";
import { BotEditor } from "./management.js";

type Tab = "activity" | "experience" | "notes" | "settings";

export function BotProfile({
  api,
  bot,
  workspace,
  latestRun,
  onMessage,
  onSaved,
}: {
  api: ApiClient;
  bot: BotDefinition;
  workspace: Workspace | undefined;
  latestRun: RunView | undefined;
  onMessage: () => void;
  onSaved: (bot: BotDefinition) => void;
}) {
  const [tab, setTab] = useState<Tab>("activity");
  const [config, setConfig] = useState<OperatorConfig>();
  const [error, setError] = useState<string>();
  const [editingAvatar, setEditingAvatar] = useState(false);
  const canConfigure = useCan("bot.configure");
  // A Guest reads no runs (ADR-0022 amendment 6 W6); the feed stays empty instead of failing.
  const canReadRuns = useCan("runs.read").allowed;
  const t = useT();

  // #113 slice R: unfinished runs plus the newest finished page, live; older pages on request.
  // A Guest reads no runs (ADR-0022 amendment 6 W6): no scope, so the feed stays empty.
  const feed = useRunFeed(api, canReadRuns ? { botId: bot.id } : undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another bot reopens on its activity tab
  useEffect(() => {
    let active = true;
    setTab("activity");
    api
      .getConfig()
      .then((c) => active && setConfig(c))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, bot.id]);
  const shownError = error ?? feed.error;

  const runList = [...feed.runs];
  const latest = runList.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? latestRun;

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "activity", label: t("botProfile.tab.activity"), icon: <Activity size={15} /> },
    { key: "experience", label: t("botProfile.tab.experience"), icon: <Sparkles size={15} /> },
    { key: "notes", label: t("botProfile.tab.notes"), icon: <StickyNote size={15} /> },
    { key: "settings", label: t("workspace.tabs.settings"), icon: <Settings2 size={15} /> },
  ];

  return (
    <article className="profile">
      <header className="profile-header">
        <button
          type="button"
          className="avatar-button"
          aria-label={t("botProfile.avatar.changeLabel", { name: bot.name })}
          title={
            canConfigure.allowed
              ? t("botProfile.avatar.changeTitle")
              : t("botProfile.avatar.onlyWho", { who: canConfigure.who })
          }
          disabled={!canConfigure.allowed}
          onClick={() => setEditingAvatar(true)}
        >
          <Avatar name={bot.name} avatar={bot.avatar} size="xl" />
          <span className="avatar-button-hint">
            <Pencil size={11} />
          </span>
        </button>
        <AvatarDialog
          key={`${bot.id}:${editingAvatar}`}
          api={api}
          botId={bot.id}
          name={bot.name}
          avatar={bot.avatar}
          open={editingAvatar}
          onClose={() => setEditingAvatar(false)}
          onSaved={(avatar) => {
            setEditingAvatar(false);
            const { avatar: _previous, ...rest } = bot;
            onSaved(avatar ? { ...rest, avatar } : rest);
          }}
        />
        <div className="profile-title">
          <h1>{bot.name}</h1>
          <p className="muted">
            {bot.role || t("botProfile.noRole")}
            {workspace ? <> · {workspace.name}</> : null}
          </p>
          <p className="profile-status">
            {latest ? (
              <>
                <RunStatusPill status={latest.status} />
                <span className="muted small">
                  {formatRelative(latest.finishedAt ?? latest.startedAt ?? latest.createdAt)}
                </span>
              </>
            ) : (
              <span className="muted small">{t("botProfile.notRunYet")}</span>
            )}
          </p>
        </div>
        <div className="profile-actions">
          <Button variant="default" onClick={onMessage}>
            <MessageSquare size={15} /> {t("botProfile.message")}
          </Button>
        </div>
      </header>
      <nav className="app-tabs" aria-label={t("botProfile.sections")}>
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? "active" : ""}
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
      {shownError ? <p className="error">{shownError}</p> : null}

      {tab === "activity" ? (
        <div className="activity">
          <div className="activity-top">
            <DesktopCard
              api={api}
              member={{ botId: bot.id, name: bot.name }}
              workspaceId={bot.workspaceId}
            />
            <section className="card">
              <h3>{t("botProfile.glance.title")}</h3>
              <dl className="kv">
                <dt>{t("botProfile.glance.model")}</dt>
                <dd>
                  <code>
                    {bot.model || config?.defaultModel || t("botProfile.glance.defaultModel")}
                  </code>
                </dd>
                <dt>{t("botProfile.glance.schedules")}</dt>
                <dd>
                  {bot.cron.length > 0
                    ? t("botProfile.glance.scheduleCount", { count: bot.cron.length })
                    : t("botProfile.glance.none")}
                  {" · "}
                  <button type="button" className="link-button" onClick={() => setTab("settings")}>
                    {bot.cron.length > 0
                      ? t("botProfile.glance.edit")
                      : t("botProfile.glance.addOne")}
                  </button>
                </dd>
                <dt>{t("botProfile.glance.connectors")}</dt>
                <dd>
                  {bot.connectors.length > 0
                    ? bot.connectors.join(", ")
                    : t("botProfile.glance.none")}
                </dd>
                <dt>{t("botProfile.glance.lastStatus")}</dt>
                <dd>
                  {latest ? RUN_STATUS_LABEL[latest.status] : t("botProfile.glance.neverRan")}
                </dd>
                <dt>{t("botProfile.glance.created")}</dt>
                <dd>{formatDateTime(bot.createdAt)}</dd>
              </dl>
            </section>
          </div>
          <h3>{t("botProfile.recentActivity")}</h3>
          <BotActivity
            bot={bot}
            runs={runList}
            timeZone={config?.cronTimeZone}
            onEditSchedules={() => setTab("settings")}
            older={
              feed.hasOlder
                ? { loading: feed.loadingOlder, onLoad: () => void feed.loadOlder() }
                : undefined
            }
          />
        </div>
      ) : null}

      {tab === "experience" ? (
        <section className="card">
          <h3>{t("botProfile.experience.title")}</h3>
          <p className="muted small">{t("botProfile.experience.body", { name: bot.name })}</p>
          <LearnedMemoryScreen
            api={api}
            embedded
            workspaceId={bot.workspaceId}
            owner={{ kind: "bot", botId: bot.id }}
          />
        </section>
      ) : null}

      {tab === "notes" ? (
        <section className="card">
          <MemoryPanel api={api} botId={bot.id} />
        </section>
      ) : null}

      {tab === "settings" && config ? (
        <BotEditor
          api={api}
          bot={bot}
          config={config}
          timeZone={config.cronTimeZone}
          workspaceName={workspace?.name ?? t("botProfile.unknownWorkspace")}
          onSaved={onSaved}
        />
      ) : null}
    </article>
  );
}
