// Unfinished work in an open chat, grouped by bot (issue #126). One compact row per bot that has
// an unfinished run in this chat: what it is doing now (running) or waiting for (approval, the
// browser, a continue decision, its turn in the queue), plus how many more runs it has. Queued and
// parked runs are never described as executing. Expanding a bot lists every one of its
// unfinished runs with its exact status, lane, trigger and run link, and that run's own Stop
// (issue #76, `chat-run-stop.tsx`). A bot may have runs on both lanes at once (ADR-0005), so the
// list never assumes one live run per bot. Summary and list are computed from the same run list
// on every render, so live updates and reconnect snapshots keep them consistent, and a run that
// reaches a terminal status leaves both at once. Presentation only: no scheduling, run identity,
// approval or cancellation-scope change, and no bulk stop.

import type { RunStatus, Thread } from "@deskmates/contracts";
import { ChevronDown, Clock, Hourglass, PauseCircle, ShieldAlert, Square } from "lucide-react";
import { useId, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import { formatTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runHref } from "../../router.js";
import { RoleNote, useCanInOwnSideChat } from "../../state/session-roles.js";
import { runStatusLabel } from "../../state/thread-view.js";
import { useRunStop } from "./chat-run-stop.js";

/** What a bot's row says it is doing; only `running` is described as executing. */
export type BotRunState = "running" | "approval" | "browser" | "paused" | "queued";

export interface BotRunGroup {
  botId: string;
  /** Every unfinished run of this bot in this chat, oldest first. */
  runs: RunView[];
  state: BotRunState;
  /** The run the summary describes: the oldest run in `state`. */
  current: RunView;
  /** Other runs of this bot, by kind. */
  queued: number;
  moreRunning: number;
  moreWaiting: number;
}

const STATE_ORDER: readonly BotRunState[] = ["running", "approval", "browser", "paused", "queued"];

export function botRunState(status: RunStatus): BotRunState {
  switch (status) {
    case "running":
    case "stalled":
      return "running";
    case "waiting_approval_live":
    case "waiting_approval":
      return "approval";
    case "waiting_browser":
      return "browser";
    case "waiting_continuation":
      return "paused";
    default:
      return "queued";
  }
}

/**
 * Unfinished runs grouped by bot, in the order each bot's oldest run appeared. The summary state
 * is the most active one any of the bot's runs is in.
 */
export function groupRunsByBot(runs: readonly RunView[]): BotRunGroup[] {
  const byBot = new Map<string, RunView[]>();
  for (const run of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    byBot.set(run.botId, [...(byBot.get(run.botId) ?? []), run]);
  }
  return [...byBot.entries()].map(([botId, list]) => {
    const state =
      STATE_ORDER.find((s) => list.some((run) => botRunState(run.status) === s)) ?? "queued";
    const current = list.find((run) => botRunState(run.status) === state) ?? (list[0] as RunView);
    const others = list.filter((run) => run !== current);
    return {
      botId,
      runs: list,
      state,
      current,
      queued: others.filter((run) => run.status === "queued").length,
      moreRunning: others.filter((run) => run.status === "running").length,
      moreWaiting: others.filter((run) => run.status !== "queued" && run.status !== "running")
        .length,
    };
  });
}

const SUMMARY_KEYS: Readonly<Record<BotRunState, MessageKey>> = {
  running: "chatRunStatus.summary.running",
  approval: "chatRunStatus.summary.approval",
  browser: "chatRunStatus.summary.browser",
  paused: "chatRunStatus.summary.paused",
  queued: "chatRunStatus.summary.queued",
};

const STATE_ICONS = {
  approval: ShieldAlert,
  browser: Hourglass,
  paused: PauseCircle,
  queued: Clock,
} as const;

/** A one-line excerpt of a message body for the trigger context. */
function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

export interface ChatRunStatusProps {
  api: ApiClient;
  /** Unfinished runs of this chat. Runs of other chats are never shown or offered. */
  runs: readonly RunView[];
  botName: (botId: string) => string;
  /** The body of a loaded message of this chat, to name the message a run answers. */
  messageBody: (messageId: string) => string | undefined;
  /** The chat, once loaded: a Member may cancel only in a side chat they opened. */
  thread: Pick<Thread, "kind" | "sideChatActor"> | undefined;
  memberCount: number;
  /** The run as the Gateway now reports it, after a cancel or a lost terminal-state race. */
  onRunUpdated: (run: RunView) => void;
}

export function ChatRunStatus(props: ChatRunStatusProps) {
  const { api, runs, botName, messageBody, onRunUpdated } = props;
  const t = useT();
  const baseId = useId();
  const can = useCanInOwnSideChat("run.cancel", props.thread, props.memberCount);
  const stop = useRunStop({ api, runs, botName, onRunUpdated });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const groups = groupRunsByBot(runs);

  if (groups.length === 0 && !stop.active) return null;

  const toggle = (botId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    });

  const context = (run: RunView): string => {
    switch (run.triggerKind) {
      case "thread_message": {
        const body = messageBody(run.triggerRef);
        return body
          ? t("chatRunStatus.trigger.message", { text: excerpt(body) })
          : t("chatRunStatus.trigger.messageUnknown");
      }
      case "cron":
        return t("chatRunStatus.trigger.cron");
      case "webhook":
        return t("chatRunStatus.trigger.webhook");
      case "approval":
        return t("chatRunStatus.trigger.approval");
      case "welcome":
        return t("chatRunStatus.trigger.welcome");
      default:
        return run.triggerKind;
    }
  };

  return (
    <li className="chat-run-status">
      {groups.length > 0 ? (
        <ul className="chat-run-bots" aria-label={t("chatRunStatus.label")}>
          {groups.map((group) => {
            const name = botName(group.botId);
            const open = expanded.has(group.botId);
            const listId = `${baseId}-${group.botId}`;
            const Icon = group.state === "running" ? undefined : STATE_ICONS[group.state];
            const extras = [
              group.moreRunning > 0
                ? t("chatRunStatus.extra.running", { count: group.moreRunning })
                : undefined,
              group.moreWaiting > 0
                ? t("chatRunStatus.extra.waiting", { count: group.moreWaiting })
                : undefined,
              group.queued > 0
                ? t("chatRunStatus.extra.queued", { count: group.queued })
                : undefined,
            ].filter((text): text is string => text !== undefined);
            return (
              <li
                key={group.botId}
                className="typing chat-run-bot"
                data-testid="typing"
                data-state={group.state}
              >
                <div className="chat-run-bot-summary">
                  <Avatar name={name} />
                  {Icon ? (
                    <span className="chat-run-bot-icon" aria-hidden="true">
                      <Icon size={14} />
                    </span>
                  ) : (
                    <span className="typing-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  <span className="muted chat-run-bot-text">
                    <span>
                      {t.rich(SUMMARY_KEYS[group.state], {
                        name,
                        author: (text) => <span className="author bot">{text}</span>,
                      })}
                    </span>
                    {extras.map((text) => (
                      <span key={text} className="chat-run-bot-extra">
                        {text}
                      </span>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="chat-run-toggle"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-label={t("chatRunStatus.toggleLabel", {
                      name,
                      count: group.runs.length,
                    })}
                    onClick={() => toggle(group.botId)}
                  >
                    {t("chatRunStatus.toggle", { count: group.runs.length })}
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                </div>
                <div id={listId} className="chat-run-details" hidden={!open}>
                  <ul className="chat-run-list" aria-label={t("chatRunStatus.runsOf", { name })}>
                    {group.runs.map((run) => {
                      const status = runStatusLabel(run.status);
                      const about = context(run);
                      const busy = stop.stopping.has(run.id);
                      return (
                        <li key={run.id} className="chat-run-item" data-run-id={run.id}>
                          <div className="chat-run-item-facts">
                            <span className={`status ${run.status}`}>{status}</span>
                            <span className="muted small">
                              {run.lane === "background"
                                ? t("chatRunStatus.lane.background")
                                : t("chatRunStatus.lane.interactive")}
                            </span>
                            <time className="muted small" dateTime={run.createdAt}>
                              {formatTime(run.createdAt)}
                            </time>
                          </div>
                          <p className="chat-run-item-context small">{about}</p>
                          <div className="chat-run-item-actions">
                            <a href={runHref(run.id)} className="small" title={run.id}>
                              {t("chatRunStatus.details")}
                            </a>
                            {can.allowed ? (
                              busy ? (
                                <Button type="button" size="sm" variant="destructive" disabled>
                                  <Square size={12} aria-hidden="true" />
                                  {t("chatRunStop.stopping", { name })}
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="destructive"
                                  aria-label={t("chatRunStatus.stopLabel", {
                                    name,
                                    status,
                                    context: about,
                                  })}
                                  onClick={() => stop.ask(run)}
                                >
                                  <Square size={12} aria-hidden="true" />
                                  {t("chatRunStatus.stop")}
                                </Button>
                              )
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <RoleNote
                    action="run.cancel"
                    allowed={can.allowed}
                    does={t("run.roleNote.cancel")}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {stop.feedback}
    </li>
  );
}
