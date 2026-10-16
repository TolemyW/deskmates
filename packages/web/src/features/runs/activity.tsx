// Activity (ADR-0033): one card per run, grouped under the request round that started it (ADR-0005
// amendment 4) or, for a run outside any round, under its own trigger. A card is at most five
// lines: who and how it stands, a bounded summary, actions. Everything raw opens below on demand.
// The card's status is the run row's; a summary never declares success.

import {
  type BotId,
  type RunEvent,
  type RunId,
  type ThreadId,
  type ThreadRound,
  isTerminal,
} from "@deskmates/contracts";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import type { RunView } from "../../api/types.js";
import { Pill, runStatusTone } from "../../components/ui/pill.js";
import { errorMessage, formatDateTime, formatRelative } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runHref, threadHref } from "../../router.js";
import { runStatusLabel } from "../../state/thread-view.js";
import { ModelRetryLine } from "./model-retry.js";
import { type RunMarkActions, RunMarkBadge, RunMarkControl } from "./run-mark.js";

export type ActivityScope = "current" | "all";
export type ActivityLane = "all" | "interactive" | "background";

export interface ActivityPanelProps {
  runs: readonly RunView[];
  /** Rounds known to the caller, for group labels; a run of an unknown round still groups. */
  rounds?: readonly ThreadRound[];
  /** The round the chat highlights; "current" shows only its runs. */
  currentRoundId?: string | undefined;
  botName: (botId: string) => string;
  actorName?: (actor: string) => string;
  onRetry?: ((roundMessageId: string, botId: BotId) => Promise<unknown>) | undefined;
  loadEvents?: ((runId: RunId) => Promise<RunEvent[]>) | undefined;
  /** Runs from other conversations link to their chat (a private chat's Activity). */
  linkThreads?: boolean;
  /** Older finished runs exist (#113 slice R); the panel offers to load them. */
  older?: OlderRuns | undefined;
  /** Mark a run wrong from its card (ADR-0042 decision 3); without it the card shows the mark only. */
  markRun?: RunMarkActions | undefined;
}

/** A feed's Load older control: present only while older runs exist. */
export interface OlderRuns {
  loading: boolean;
  onLoad: () => void;
}

/** The Load older button a run feed shows below its newest page. */
export function LoadOlderRuns({ older }: { older: OlderRuns | undefined }) {
  const t = useT();
  if (!older) return null;
  return (
    <button
      type="button"
      className="link-button load-older-runs"
      disabled={older.loading}
      onClick={older.onLoad}
    >
      {older.loading ? t("activity.loadingOlder") : t("activity.loadOlder")}
    </button>
  );
}

interface Group {
  key: string;
  round?: ThreadRound | undefined;
  /** The trigger a run outside any round names. */
  trigger?: RunView | undefined;
  runs: RunView[];
  latest: string;
}

/** Summary jobs and other presentation jobs are not activity (ADR-0033 decision 1). */
export function isActivityRun(run: RunView): boolean {
  return run.config.runType === undefined || run.config.runType === null;
}

export function groupActivity(
  runs: readonly RunView[],
  rounds: readonly ThreadRound[] = [],
): Group[] {
  const byRound = new Map(rounds.map((round) => [round.messageId as string, round]));
  const groups = new Map<string, Group>();
  for (const run of runs) {
    if (!isActivityRun(run)) continue;
    const roundId = run.roundMessageIds?.[0];
    const key = roundId ? `round:${roundId}` : `trigger:${run.triggerKind}:${run.triggerRef}`;
    const group = groups.get(key) ?? {
      key,
      round: roundId ? byRound.get(roundId) : undefined,
      trigger: roundId ? undefined : run,
      runs: [],
      latest: run.createdAt,
    };
    group.runs.push(run);
    if (run.createdAt > group.latest) group.latest = run.createdAt;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      runs: group.runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

export function ActivityPanel(props: ActivityPanelProps) {
  const t = useT();
  const [scope, setScope] = useState<ActivityScope>(props.currentRoundId ? "current" : "all");
  const [lane, setLane] = useState<ActivityLane>("all");
  // A live run update carries no summary; keep the last one the list gave for that run.
  const summaries = useRef(new Map<string, RunView["activitySummary"]>());
  const runs = props.runs.map((run) => {
    if (run.activitySummary) {
      summaries.current.set(`${run.id}:${run.activitySummary.sourceVersion}`, run.activitySummary);
      return run;
    }
    const kept = summaries.current.get(`${run.id}:a${run.attempt}-${run.status}`);
    return kept ? { ...run, activitySummary: kept } : run;
  });
  const filtered = runs.filter((run) => lane === "all" || run.lane === lane);
  const groups = groupActivity(filtered, props.rounds).filter(
    (group) =>
      scope === "all" ||
      props.currentRoundId === undefined ||
      group.key === `round:${props.currentRoundId}`,
  );
  return (
    <section className="activity-panel" aria-label={t("activity.title")}>
      <div className="activity-filters">
        <fieldset aria-label={t("activity.scope.label")} className="segmented">
          {(["current", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              disabled={value === "current" && props.currentRoundId === undefined}
              onClick={() => setScope(value)}
            >
              {t(value === "current" ? "activity.scope.current" : "activity.scope.all")}
            </button>
          ))}
        </fieldset>
        <fieldset aria-label={t("activity.lane.label")} className="segmented">
          {(["all", "interactive", "background"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={lane === value}
              onClick={() => setLane(value)}
            >
              {t(
                value === "all"
                  ? "activity.lane.all"
                  : value === "interactive"
                    ? "activity.lane.foreground"
                    : "activity.lane.background",
              )}
            </button>
          ))}
        </fieldset>
      </div>
      {groups.length === 0 ? <p className="muted small">{t("activity.empty")}</p> : null}
      {groups.map((group, index) => (
        <details key={group.key} className="activity-group" open={index === 0}>
          <summary>
            <ChevronDown size={14} aria-hidden="true" />
            <GroupLabel group={group} actorName={props.actorName} botName={props.botName} />
          </summary>
          <ol className="activity-cards">
            {group.runs.map((run) => (
              <li key={run.id}>
                <ActivityCard
                  run={run}
                  roundMessageId={group.round?.messageId ?? run.roundMessageIds?.[0]}
                  botName={props.botName}
                  onRetry={props.onRetry}
                  loadEvents={props.loadEvents}
                  linkThread={props.linkThreads === true}
                  markRun={props.markRun}
                />
              </li>
            ))}
          </ol>
        </details>
      ))}
      <LoadOlderRuns older={props.older} />
    </section>
  );
}

function GroupLabel({
  group,
  actorName,
  botName,
}: {
  group: Group;
  actorName?: ((actor: string) => string) | undefined;
  botName: (botId: string) => string;
}) {
  const t = useT();
  if (group.round) {
    const who =
      group.round.authorKind === "bot"
        ? botName(group.round.authorId)
        : (actorName?.(group.round.authorId) ?? t("activity.group.human"));
    return (
      <span className="activity-group-label">
        {t("activity.group.round", { who, message: group.round.excerpt })}
      </span>
    );
  }
  const run = group.trigger ?? group.runs[0];
  if (!run) return null;
  if (run.triggerKind === "thread_message")
    return <span className="activity-group-label">{t("activity.group.message")}</span>;
  return (
    <span className="activity-group-label">
      {t("activity.group.trigger", { trigger: run.triggerKind.replaceAll("_", " ") })}
    </span>
  );
}

/** What a card says without a model: the live state, else the outcome's first line. */
function deterministicLine(run: RunView, t: ReturnType<typeof useT>): string {
  if (!isTerminal(run.status)) return runStatusLabel(run.status);
  const text =
    run.status === "failed" || run.status === "stopped"
      ? run.error
      : run.status === "silent"
        ? t("activity.silent")
        : run.status === "cancelled"
          ? (run.error ?? t("activity.cancelled"))
          : run.summary?.reply || run.summary?.done;
  const first = (text ?? "").split("\n")[0]?.trim() ?? "";
  return first.length > 120 ? `${first.slice(0, 119)}…` : first || runStatusLabel(run.status);
}

export function ActivityCard({
  run,
  roundMessageId,
  botName,
  onRetry,
  loadEvents,
  linkThread = false,
  markRun,
}: {
  run: RunView;
  markRun?: RunMarkActions | undefined;
  linkThread?: boolean;
  roundMessageId?: string | undefined;
  botName: (botId: string) => string;
  onRetry?: ((roundMessageId: string, botId: BotId) => Promise<unknown>) | undefined;
  loadEvents?: ((runId: RunId) => Promise<RunEvent[]>) | undefined;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>();
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  // A mark changed from this card shows at once; the next list read carries it too.
  const [mark, setMark] = useState(run.mark);
  const summary = run.activitySummary;
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const waitingApproval =
    run.status === "waiting_approval" || run.status === "waiting_approval_live";
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && events === undefined && loadEvents) {
      try {
        setEvents(await loadEvents(run.id as RunId));
      } catch (err) {
        setError(errorMessage(err));
      }
    }
  };
  let body: React.ReactNode;
  if (summary?.status === "ready" && summary.text) {
    body = (
      <p className="activity-summary">
        {summary.verbatim ? null : <span className="ai-label">{t("activity.aiLabel")}</span>}
        {summary.text}
      </p>
    );
  } else {
    const note =
      !isTerminal(run.status) || run.status === "silent" || run.status === "cancelled"
        ? undefined
        : summary?.status === "pending"
          ? t("activity.summaryPending")
          : summary?.status === "failed"
            ? t("activity.summaryFailed")
            : t("activity.summaryNone");
    body = (
      <p className="activity-summary fallback">
        {note ? <span className="muted small">{note} · </span> : null}
        {deterministicLine(run, t)}
      </p>
    );
  }
  const retries = (events ?? []).filter((event) => event.kind === "model_retry");
  const tools = (events ?? []).filter((event) => event.kind === "tool_call");
  return (
    <article className={`activity-card ${run.status}`} data-testid="activity-card">
      <header className="activity-card-head">
        <strong>{botName(run.botId)}</strong>
        <span className="muted small">
          {t(run.lane === "interactive" ? "activity.lane.foreground" : "activity.lane.background")}
        </span>
        <Pill tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Pill>
        <time dateTime={at} title={formatDateTime(at)} className="muted small">
          {formatRelative(at)}
        </time>
        <RunMarkBadge mark={mark} />
      </header>
      {body}
      <div className="activity-actions">
        <button type="button" className="link" aria-expanded={open} onClick={() => void toggle()}>
          {t("activity.action.original")}
        </button>
        {linkThread && run.threadId ? (
          <a className="small" href={threadHref(run.threadId as ThreadId)}>
            {t("activity.action.openChat")}
          </a>
        ) : null}
        {waitingApproval && run.threadId ? (
          <a className="small" href={threadHref(run.threadId as ThreadId)}>
            {t("activity.action.approval")}
          </a>
        ) : null}
        {(run.status === "failed" || run.status === "stopped") && roundMessageId && onRetry ? (
          <button
            type="button"
            className="link"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              setError(undefined);
              try {
                await onRetry(roundMessageId, run.botId);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setRetrying(false);
              }
            }}
          >
            {t("activity.action.retry")}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
      {open ? (
        <div className="activity-raw" data-testid="activity-raw">
          {run.summary?.reply ? <pre>{run.summary.reply}</pre> : null}
          {run.summary?.done ? <p className="small">{run.summary.done}</p> : null}
          {run.error ? <pre className="error">{run.error}</pre> : null}
          {retries.map((event) => (
            <ModelRetryLine key={event.seq} payload={event.payload} />
          ))}
          {tools.length > 0 ? (
            <ul className="small">
              {tools.map((event) => (
                <li key={event.seq}>
                  {String(event.payload.toolName ?? event.payload.name ?? "tool")}
                </li>
              ))}
            </ul>
          ) : null}
          {markRun ? (
            <RunMarkControl
              runId={run.id as RunId}
              mark={mark}
              actions={markRun}
              onChange={setMark}
            />
          ) : null}
          <p className="muted small">
            <a href={runHref(run.id)}>{t("activity.audit", { runId: run.id })}</a>
            {roundMessageId ? ` · ${roundMessageId}` : ""}
          </p>
        </div>
      ) : null}
    </article>
  );
}
