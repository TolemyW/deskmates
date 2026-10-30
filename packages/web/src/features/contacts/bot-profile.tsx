// A bot's profile: what it is doing (its activity feed and desktop), what it knows, and how it
// is configured. Memory follows its owner here: the bot's own experience and the operator's
// notes live on the profile, workspace facts on the workspace page and task notes on the chat.

import type { BotDefinition, OperatorConfig, Workspace } from "@deskmates/contracts";
import { Pill, SectionTabs } from "@deskmates/ui";
import {
  Activity,
  MessageSquare,
  Pencil,
  Settings2,
  Sparkles,
  Star,
  StickyNote,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import { RunStatusPill } from "../../components/ui/pill.js";
import { errorMessage, formatDateTime, formatRelative } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import { useCan } from "../../state/session-roles.js";
import { DesktopCard } from "../computer/desktop-rail.js";
import { BotChannels } from "../integrations/bot-channels.js";
import { MemoryPanel } from "../knowledge/knowledge.js";
import { LearnedMemoryScreen } from "../knowledge/learned-memory.js";
import { useRunFeed } from "../runs/run-feed.js";
import { AvatarDialog } from "./avatar-picker.js";
import { BotActivity } from "./bot-activity.js";
import { BotDiary } from "./bot-diary.js";
import { BotEditor } from "./management.js";
import { RuleVersions } from "./rule-versions.js";

type Tab = "activity" | "experience" | "notes" | "settings";

export function BotProfile({
  api,
  bot,
  workspace,
  latestRun,
  onMessage,
  onSaved,
  onWorkspaceSaved,
}: {
  api: ApiClient;
  bot: BotDefinition;
  workspace: Workspace | undefined;
  latestRun: RunView | undefined;
  onMessage: () => void;
  onSaved: (bot: BotDefinition) => void;
  /** The workspace after this bot became its default bot (ADR-0051). */
  onWorkspaceSaved?: (workspace: Workspace) => void;
}) {
  const [tab, setTab] = useState<Tab>("activity");
  const [config, setConfig] = useState<OperatorConfig>();
  const [error, setError] = useState<string>();
  const [editingAvatar, setEditingAvatar] = useState(false);
  const canConfigure = useCan("bot.configure", bot.workspaceId);
  const canSetDefault = useCan("workspace.setDefaultBot", bot.workspaceId).allowed;
  const [settingDefault, setSettingDefault] = useState(false);
  const isDefault = workspace?.defaultBotId === bot.id;
  // A Guest reads no runs (ADR-0022 amendment 6 W6); the feed stays empty instead of failing.
  const canReadRuns = useCan("runs.read", bot.workspaceId).allowed;
  const t = useT();
  const tune = useTuneView();

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
  const shownError = error;

  const makeDefault = async () => {
    setSettingDefault(true);
    setError(undefined);
    try {
      onWorkspaceSaved?.(await api.setDefaultBot(bot.workspaceId, bot.id));
    } catch (err) {
      setError(t("botProfile.makeDefaultFailed", { name: bot.name, error: errorMessage(err) }));
    } finally {
      setSettingDefault(false);
    }
  };

  const runList = [...feed.runs];
  const latest =
    runList
      .filter((run) => run.triggerKind !== "model_job" && !run.config.runType)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? latestRun;

  // The long-term instructions (MEMORY.md with its versions, and the diary) are for tuning.
  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "activity", label: t("botProfile.tab.activity"), icon: <Activity size={15} /> },
    { key: "experience", label: t("botProfile.tab.experience"), icon: <Sparkles size={15} /> },
    ...(tune
      ? [
          {
            key: "notes" as const,
            label: t("botProfile.tab.notes"),
            icon: <StickyNote size={15} />,
          },
        ]
      : []),
    { key: "settings", label: t("workspace.tabs.settings"), icon: <Settings2 size={15} /> },
  ];
  const shownTab: Tab = tabs.some((item) => item.key === tab) ? tab : "activity";

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
            {isDefault ? (
              <Pill tone="info" title={t("botProfile.defaultTitle")}>
                {t("botProfile.default")}
              </Pill>
            ) : null}
            {bot.pausedAt ? (
              <span className="pill warning" title={t("botProfile.pausedTitle")}>
                {t("botProfile.paused")}
              </span>
            ) : null}
            {canReadRuns && latest ? (
              <>
                <RunStatusPill status={latest.status} />
                <span className="muted small">
                  {formatRelative(latest.finishedAt ?? latest.startedAt ?? latest.createdAt)}
                </span>
              </>
            ) : canReadRuns && !feed.loading && !feed.error ? (
              <span className="muted small">{t("botProfile.notRunYet")}</span>
            ) : null}
          </p>
        </div>
        <div className="profile-actions">
          {canSetDefault && workspace && !isDefault ? (
            <Button
              variant="tertiary"
              disabled={settingDefault}
              title={t("botProfile.makeDefaultTitle", { name: bot.name })}
              onClick={() => void makeDefault()}
            >
              <Star size={15} /> {t("botProfile.makeDefault")}
            </Button>
          ) : null}
          <Button variant="default" onClick={onMessage}>
            <MessageSquare size={15} /> {t("botProfile.message")}
          </Button>
        </div>
      </header>
      <SectionTabs label={t("botProfile.sections")} items={tabs} value={shownTab} onChange={setTab}>
        {shownError ? <p className="error">{shownError}</p> : null}

        {shownTab === "activity" ? (
          <div className="activity">
            {canReadRuns ? (
              <>
                <h3>{t("botProfile.recentActivity")}</h3>
                {feed.loading && runList.length === 0 ? <output>{t("run.loading")}</output> : null}
                {feed.error ? (
                  <div role="alert">
                    <p className="error">{feed.error}</p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={feed.loading}
                      onClick={() => void feed.reload()}
                    >
                      {t("contacts.retry")}
                    </Button>
                  </div>
                ) : null}
                {runList.length > 0 || (!feed.loading && !feed.error) ? (
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
                ) : null}
              </>
            ) : null}
            <div className="activity-top">
              <DesktopCard
                api={api}
                member={{ botId: bot.id, name: bot.name }}
                workspaceId={bot.workspaceId}
              />
              <details className="card profile-summary">
                <summary>{t("botProfile.glance.title")}</summary>
                <dl className="kv">
                  <dt>{t("botProfile.glance.model")}</dt>
                  <dd>
                    <code title={bot.model || config?.defaultModel || undefined}>
                      {bot.model || config?.defaultModel || t("botProfile.glance.defaultModel")}
                    </code>
                  </dd>
                  <dt>{t("botProfile.glance.schedules")}</dt>
                  <dd>
                    {bot.cron.length > 0
                      ? t("botProfile.glance.scheduleCount", { count: bot.cron.length })
                      : t("botProfile.glance.none")}
                    {" · "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setTab("settings")}
                    >
                      {bot.cron.length > 0
                        ? t("botProfile.glance.edit")
                        : t("botProfile.glance.addOne")}
                    </button>
                  </dd>
                  <BotChannels api={api} bot={bot} />
                  <dt>{t("botProfile.glance.connectors")}</dt>
                  <dd>
                    {bot.connectors.length > 0
                      ? bot.connectors.join(", ")
                      : t("botProfile.glance.none")}
                  </dd>
                  <dt>{t("botProfile.glance.created")}</dt>
                  <dd>{formatDateTime(bot.createdAt)}</dd>
                </dl>
              </details>
            </div>
          </div>
        ) : null}

        {shownTab === "experience" ? (
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

        {shownTab === "notes" ? (
          <>
            <section className="card">
              <MemoryPanel
                api={api}
                botId={bot.id}
                versions={(current) => (
                  <RuleVersions
                    api={api}
                    bot={bot}
                    file="memory"
                    currentVersion={current.version}
                    refreshKey={current.version}
                    disabled={current.dirty}
                    onRestored={current.reload}
                  />
                )}
              />
            </section>
            <section className="card">
              <BotDiary api={api} bot={bot} />
            </section>
          </>
        ) : null}

        {shownTab === "settings" && config ? (
          <BotEditor
            api={api}
            bot={bot}
            config={config}
            timeZone={config.cronTimeZone}
            workspaceName={workspace?.name ?? t("botProfile.unknownWorkspace")}
            onSaved={onSaved}
          />
        ) : null}
      </SectionTabs>
    </article>
  );
}
