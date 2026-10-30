// A bot's activity feed: one read-only entry per run (started, waiting, finished, failed),
// assembled from the run ledger and kept current by the live run stream, with the bot's
// schedule on top. The bot writes nothing here itself; the Gateway's records are the feed.

import type { BotDefinition, RunStatus, RunTriggerKind } from "@deskmates/contracts";
import { boundActivitySummary, nextCronFire } from "@deskmates/contracts";
import { CalendarClock } from "lucide-react";
import type { RunView } from "../../api/types.js";
import { Avatar } from "../../components/ui/avatar.js";
import { RUN_STATUS_LABEL, RunStatusPill } from "../../components/ui/pill.js";
import { describeRunError, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { Markdown } from "../../lib/markdown.js";
import { runHref, threadHref } from "../../router.js";
import { LoadOlderRuns, type OlderRuns } from "../runs/activity.js";

/** What woke the run, in words a reader of the feed uses. */
export function triggerLabel(kind: RunTriggerKind): string {
  const { t } = currentI18n();
  switch (kind) {
    case "cron":
      return t("botActivity.trigger.cron");
    case "thread_message":
      return t("botActivity.trigger.threadMessage");
    case "webhook":
      return t("botActivity.trigger.webhook");
    case "approval":
      return t("botActivity.trigger.approval");
    case "manual":
      return t("botActivity.trigger.manual");
    case "model_job":
      return t("botActivity.trigger.modelJob");
    default:
      return String(kind).replaceAll("_", " ");
  }
}

/** "in 5 min", "in 3 h", "in 2 d": how far away a future time is. */
export function untilLabel(at: Date, now: Date): string {
  const { t } = currentI18n();
  const minutes = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
  if (minutes < 1) return t("botActivity.until.now");
  if (minutes < 60) return t("botActivity.until.minutes", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("botActivity.until.hours", { hours });
  return t("botActivity.until.days", { days: Math.round(hours / 24) });
}

/** The next firing of a cron expression, or undefined when it cannot be computed. */
export function nextFiring(schedule: string, timeZone: string | undefined, now = new Date()) {
  try {
    return nextCronFire(schedule, now, timeZone);
  } catch {
    return undefined;
  }
}

export interface FeedItem {
  id: string;
  at: string;
  status: RunStatus;
  title: string;
  detail?: string | undefined;
  runId: string;
  threadId?: string | undefined;
}

/** One feed entry per run: what the run tells a reader who was not watching. */
export function feedItemOf(run: RunView): FeedItem {
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const { t } = currentI18n();
  const trigger = triggerLabel(run.triggerKind);
  const wokenBy = t("botActivity.feed.wokenBy", { trigger });
  const base = { id: run.id, at, status: run.status, runId: run.id, threadId: run.threadId };
  const error = run.error ? describeRunError(run.error) : undefined;
  if (run.triggerKind === "model_job" || run.config.runType)
    return {
      ...base,
      title: t("botActivity.feed.background"),
      detail: error ?? (run.summary?.done ? boundActivitySummary(run.summary.done) : wokenBy),
    };
  switch (run.status) {
    case "succeeded":
      return {
        ...base,
        title: t("botActivity.feed.finishedTask"),
        detail:
          run.summary?.done || run.summary?.reply
            ? boundActivitySummary(run.summary.done || run.summary.reply)
            : undefined,
      };
    case "silent":
      return { ...base, title: t("botActivity.feed.silent"), detail: wokenBy };
    case "failed":
      return { ...base, title: t("botActivity.feed.failed"), detail: error };
    case "cancelled":
      return { ...base, title: t("botActivity.feed.cancelled"), detail: error };
    case "stopped":
      return { ...base, title: t("botActivity.feed.stopped"), detail: error };
    case "waiting_approval":
    case "waiting_approval_live":
      return { ...base, title: t("botActivity.feed.waitingApproval"), detail: wokenBy };
    case "waiting_browser":
      return {
        ...base,
        title: t("botActivity.feed.waitingBrowser"),
        detail: t("botActivity.feed.humanHolds"),
      };
    case "waiting_continuation":
      return {
        ...base,
        title: t("botActivity.feed.outOfTurns"),
        detail: t("botActivity.feed.delegatorDecides"),
      };
    case "running":
      return { ...base, title: t("botActivity.feed.working"), detail: wokenBy };
    default:
      return { ...base, title: RUN_STATUS_LABEL[run.status], detail: wokenBy };
  }
}

export function BotActivity({
  bot,
  runs,
  timeZone,
  onEditSchedules,
  older,
}: {
  bot: BotDefinition;
  runs: readonly RunView[];
  /** The Gateway's cron time zone, for the next-firing times. */
  timeZone?: string | undefined;
  /** Opens the schedule editor (the profile's settings tab). */
  onEditSchedules?: (() => void) | undefined;
  /** Older finished runs exist (#113 slice R). */
  older?: OlderRuns | undefined;
}) {
  const feed = runs
    .filter((run) => run.botId === bot.id)
    .map(feedItemOf)
    .sort((a, b) => b.at.localeCompare(a.at));
  const now = new Date();
  const t = useT();
  return (
    <div className="channel-feed" aria-label={t("botActivity.label")}>
      {bot.cron.length > 0 ? (
        <div className="feed-item scheduled">
          <span className="feed-icon">
            <CalendarClock size={16} />
          </span>
          <div className="feed-main">
            <strong>{t("botActivity.schedule.title")}</strong>
            <p className="muted small">{t("botActivity.schedule.body", { name: bot.name })}</p>
            <ul className="schedule-list">
              {bot.cron.map((entry) => {
                const next = nextFiring(entry.schedule, timeZone, now);
                return (
                  <li key={`${entry.schedule}:${entry.prompt}`}>
                    <code
                      title={
                        timeZone
                          ? t("botActivity.schedule.cronZone", { timeZone })
                          : t("botActivity.schedule.cron")
                      }
                    >
                      {entry.schedule}
                    </code>
                    <span>
                      {entry.prompt}
                      {next ? (
                        <span className="muted small schedule-next">
                          {" "}
                          {t("botActivity.schedule.next", {
                            until: untilLabel(next, now),
                            at: formatDateTime(next.toISOString()),
                          })}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {onEditSchedules ? (
              <p className="small feed-links">
                <button type="button" className="link-button" onClick={onEditSchedules}>
                  {t("botActivity.schedule.edit")}
                </button>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {feed.length === 0 ? (
        <p className="muted small">{t("botActivity.empty", { name: bot.name })}</p>
      ) : (
        feed.map((item) => (
          <article key={item.id} className={`feed-item ${item.status}`}>
            <span className="feed-icon">
              <Avatar name={bot.name} size="sm" />
            </span>
            <div className="feed-main">
              <div className="feed-head">
                <RunStatusPill status={item.status} />
                <time className="muted small" dateTime={item.at}>
                  {formatDateTime(item.at)}
                </time>
              </div>
              <strong>{item.title}</strong>
              {item.detail ? (
                <div className="feed-detail md">
                  <Markdown text={item.detail} />
                </div>
              ) : null}
              <p className="small feed-links">
                <a href={runHref(item.runId)}>{t("botActivity.runDetails")}</a>
                {item.threadId ? (
                  <>
                    {" · "}
                    <a href={threadHref(item.threadId)}>{t("botActivity.openChat")}</a>
                  </>
                ) : null}
              </p>
            </div>
          </article>
        ))
      )}
      <LoadOlderRuns older={older} />
    </div>
  );
}
