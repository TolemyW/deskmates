import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@deskmates/ui";
// Run replay screen (M0): the status, who started the run and how long it took, then the story
// of what the bot did (`run-story-panel.tsx`), with the facts, usage, progress panel, timelines and
// changes behind "Details" and the raw ledger behind "Technical log", appended live over SSE
// while the run is still going. Issue #9: a tool call and its result are one row, phase timing
// is its own timeline, and diagnostic log rows are collapsed until asked for (`ledger-rows.ts`).

import {
  type RunEvent,
  type RunId,
  type RunLane,
  type RunStatus,
  type RunTriggerKind,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  isTerminal,
} from "@deskmates/contracts";
import { useEffect, useReducer, useRef, useState } from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { ApiError, type GatewayEvent } from "../../api/types.js";
import { DeletedObjectState } from "../../components/deleted-object-state.js";
import { Button } from "../../components/ui/button.js";
import {
  describeRunError,
  errorMessage,
  formatCost,
  formatDateTime,
  formatDuration,
} from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import { Markdown } from "../../lib/markdown.js";
import { runHref, threadHref } from "../../router.js";
import { initialRunView, runViewReducer } from "../../state/run-view.js";
import { RoleNote, useCanInOwnSideChat } from "../../state/session-roles.js";
import { AnalyticsRunLink } from "../analytics/analytics-run-link.js";
import { eventsShown, isDiagnosticEvent, ledgerRows } from "./ledger-rows.js";
import { PhaseTimingTimeline, phaseSpans } from "./phase-timing.js";
import { RunChangesSection } from "./run-changes.js";
import { RunContextPanel } from "./run-context-panel.js";
import { RunEventRow } from "./run-event-row.js";
import { RunStory } from "./run-story-panel.js";
import { RunTimelinePanel } from "./run-timeline.js";
import { ToolCallRow } from "./tool-call-row.js";

/** A run's status as the pill shows it, always as localized words rather than an internal code. */
const RUN_STATUS_LABEL: Readonly<Record<RunStatus, MessageKey>> = {
  queued: "run.status.queued",
  running: "run.status.running",
  stalled: "run.status.stalled",
  waiting_approval_live: "run.status.waitingApprovalLive",
  waiting_approval: "run.status.waitingApproval",
  waiting_browser: "run.status.waitingBrowser",
  waiting_continuation: "run.status.waitingContinuation",
  waiting_platform: "run.status.waitingPlatform",
  succeeded: "run.status.succeeded",
  silent: "run.status.silent",
  failed: "run.status.failed",
  cancelled: "run.status.cancelled",
  stopped: "run.status.stopped",
};

const LANE_LABEL: Readonly<Record<RunLane, MessageKey>> = {
  interactive: "run.lane.interactive",
  background: "run.lane.background",
};

const TRIGGER_LABEL: Readonly<Record<RunTriggerKind, MessageKey>> = {
  thread_message: "run.trigger.threadMessage",
  cron: "run.trigger.cron",
  webhook: "run.trigger.webhook",
  approval: "run.trigger.approval",
  welcome: "run.trigger.welcome",
  manual: "run.trigger.manual",
  model_job: "run.trigger.modelJob",
};

/** The trigger as the lede reads it: "started by a message in the chat". */
const TRIGGER_STORY: Readonly<Record<RunTriggerKind, MessageKey>> = {
  thread_message: "runStory.trigger.threadMessage",
  cron: "runStory.trigger.cron",
  webhook: "runStory.trigger.webhook",
  approval: "runStory.trigger.approval",
  welcome: "runStory.trigger.welcome",
  manual: "runStory.trigger.manual",
  model_job: "runStory.trigger.modelJob",
};

export interface RunScreenProps {
  runId: RunId;
  api?: ApiClient;
}

export function RunScreen(props: RunScreenProps) {
  // `useReducer` only applies its initializer on mount. Keep the route identity at this boundary
  // so navigating directly from run A to run B cannot paint A's replay while B is loading.
  return <RunScreenContent key={props.runId} {...props} />;
}

function RunScreenContent(props: RunScreenProps) {
  const { runId } = props;
  const api = props.api ?? defaultApi;
  const t = useT();
  // Tokens, timings and the technical log are for tuning (docs/use-and-tune-views.md); the use
  // view keeps the story, the facts, what the run changed and the continuation controls.
  const tune = useTuneView();
  const [state, dispatch] = useReducer(runViewReducer, runId, initialRunView);
  const [error, setError] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [oldestFirst, setOldestFirst] = useState(false);
  // #113 slice R: the replay opens on the newest events; older ones load on request.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The subscription callbacks outlive a render, so the refetch reads the event list from a ref.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Issue #15: the startup timeline sits in the collapsed Details; the header link opens it there.
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const showTimeline = (): void => {
    if (detailsRef.current) detailsRef.current.open = true;
    timelineRef.current?.scrollIntoView?.({ block: "start" });
    timelineRef.current?.focus({ preventScroll: true });
  };

  // The stream is opened before the first fetch: subscribing afterwards drops every frame emitted
  // in between, and a short run can finish there. The reducer merges, so an overlap is free but a
  // gap is not. The stream starts unfiltered because the run's thread is only known once `getRun`
  // answers; it is then narrowed to that thread, and the unfiltered one is closed only after the
  // narrowed one is open so the swap has no gap of its own. Cron and webhook runs have no thread
  // and stay on the unfiltered stream, where the reducer drops other runs' frames.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry starts a fresh subscription and fetch.
  useEffect(() => {
    let cancelled = false;
    let stopWide: (() => void) | undefined;
    let stopScoped: (() => void) | undefined;
    setMissing(false);
    setError(undefined);

    const fail = (err: unknown): void => {
      if (cancelled) return;
      if (err instanceof ApiError && err.status === 404) {
        setMissing(true);
        stopWide?.();
        stopWide = undefined;
        stopScoped?.();
        stopScoped = undefined;
        return;
      }
      setError(errorMessage(err));
    };

    /** Ask for what the stream may not have delivered; the reducer merges it in. */
    const refetch = async (): Promise<void> => {
      const afterSeq = stateRef.current.events.at(-1)?.seq;
      const [{ run, usage, usageCoverage }, events] = await Promise.all([
        api.getRun(runId),
        afterSeq === undefined ? newestEvents() : tailAfter(afterSeq),
      ]);
      if (!cancelled) dispatch({ type: "loaded", run, usage, usageCoverage, events });
    };

    /** The newest window; whether older events exist is remembered for Load older. */
    const newestEvents = async () => {
      const slice = await api.listRunEventSlice(runId);
      if (!cancelled) setHasOlder(slice.hasOlder === true);
      return slice.events;
    };

    /** What the stream missed after `afterSeq`, read as bounded tails until none is left. */
    const tailAfter = async (afterSeq: number) => {
      const events: RunEvent[] = [];
      let after = afterSeq;
      for (let more = true; more && !cancelled; ) {
        const slice = await api.listRunEventSlice(runId, { afterSeq: after });
        events.push(...slice.events);
        after = slice.events.at(-1)?.seq ?? after;
        more = slice.hasMore === true && slice.events.length > 0;
      }
      return events;
    };

    const onReconnect = (): void => {
      void refetch().catch(fail);
    };

    const onEvent = (event: GatewayEvent): void => {
      if (!cancelled) dispatch(event);
    };

    const narrow = (threadId: ThreadId): void => {
      stopScoped = subscribeEvents({
        threadId,
        onEvent,
        onReconnect,
        onStatus: (s) => {
          if (s !== "open") return;
          stopWide?.();
          stopWide = undefined;
        },
      });
    };

    stopWide = subscribeEvents({ onEvent, onReconnect });
    api
      .getRun(runId)
      .then(async ({ run, usage, usageCoverage }) => {
        if (cancelled) return;
        if (run.threadId) narrow(run.threadId);
        const events = await newestEvents();
        if (!cancelled) dispatch({ type: "loaded", run, usage, usageCoverage, events });
      })
      .catch((err: unknown) => {
        fail(err);
      });
    return () => {
      cancelled = true;
      stopWide?.();
      stopScoped?.();
    };
  }, [runId, api, loadRevision]);

  // Usage is only written at the end of a run, so refetch once the status turns terminal.
  const status = state.run?.status;
  useEffect(() => {
    if (
      !status ||
      (!isTerminal(status) &&
        status !== "waiting_continuation" &&
        status !== "waiting_approval" &&
        // ADR-0029 decision 8: a platform park may have just filled the attempt's usage in.
        status !== "waiting_platform")
    )
      return;
    let cancelled = false;
    api
      .getRun(runId)
      .then(({ run, usage, usageCoverage }) => {
        if (!cancelled) dispatch({ type: "loaded", run, usage, usageCoverage, events: [] });
      })
      .catch(() => {
        // The header already shows the status; a failed usage refresh is not worth an error.
      });
    return () => {
      cancelled = true;
    };
  }, [status, runId, api]);

  const loadOlder = async () => {
    const first = state.events[0]?.seq;
    if (first === undefined || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const slice = await api.listRunEventSlice(runId, { beforeSeq: first });
      setHasOlder(slice.hasOlder === true);
      const current = state.run;
      if (current)
        dispatch({
          type: "loaded",
          run: current,
          usage: state.usage,
          usageCoverage: state.usageCoverage,
          events: slice.events,
        });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const run = state.run;
  // #113 §3.2: the one bot this run names, not the whole roster; its name heads the screen and
  // its workspace serves the evidence files. A failed read leaves the id in the facts.
  const [bot, setBot] = useState<{ name: string; workspaceId: WorkspaceId }>();
  const botId = run?.botId;
  const [lookupRevision, setLookupRevision] = useState(0);
  const [botLookupFailed, setBotLookupFailed] = useState(false);
  const [threadLookupFailed, setThreadLookupFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lookupRevision retries this scoped read.
  useEffect(() => {
    let cancelled = false;
    if (botId) {
      setBotLookupFailed(false);
      void api
        .listBotsByIds([botId])
        .then((bots) => {
          const found = bots.find((b) => b.id === botId);
          if (!cancelled && found) setBot({ name: found.name, workspaceId: found.workspaceId });
        })
        .catch(() => {
          if (!cancelled) setBotLookupFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [api, botId, lookupRevision]);
  const evidenceWorkspace = bot?.workspaceId;
  // Resolve the run thread even when the selected workspace role is Admin: its actual
  // workspace and private-chat ownership determine cancellation/continuation (ADR-0022).
  const [runThread, setRunThread] = useState<{ thread: Thread; memberCount: number }>();
  const runThreadId = run?.threadId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: lookupRevision retries this scoped read.
  useEffect(() => {
    if (runThreadId === undefined) return;
    let active = true;
    setThreadLookupFailed(false);
    api
      .getThread(runThreadId)
      .then((detail) => {
        if (active) setRunThread({ thread: detail.thread, memberCount: detail.members.length });
      })
      .catch(() => {
        if (active) setThreadLookupFailed(true);
      });
    return () => {
      active = false;
    };
  }, [api, runThreadId, lookupRevision]);
  const canCancel = useCanInOwnSideChat(
    "run.cancel",
    runThread?.thread,
    runThread?.memberCount ?? 0,
    evidenceWorkspace ?? null,
  );
  const canContinue = useCanInOwnSideChat(
    "run.continue",
    runThread?.thread,
    runThread?.memberCount ?? 0,
    evidenceWorkspace ?? null,
  );
  const cancel = async (): Promise<void> => {
    setCancelling(true);
    setError(undefined);
    try {
      const { run: updated } = await api.cancelRun(runId);
      dispatch({ type: "run_status", run: updated });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };
  const diagnosticCount = state.events.filter(isDiagnosticEvent).length;
  const rows = ledgerRows(state.events, { diagnostics: showDiagnostics });
  const shown = eventsShown(rows);
  const spanCount = phaseSpans(state.events).length;
  const evidenceUrl = evidenceWorkspace
    ? (path: string) => api.workspaceFileDownloadUrl(evidenceWorkspace, path)
    : undefined;

  const live = run !== undefined && !isTerminal(run.status);
  const waitingContinuation = run?.status === "waiting_continuation";
  const trigger = run ? TRIGGER_STORY[run.triggerKind] : undefined;

  if (missing)
    return (
      <section className="run-screen" data-run-id={runId}>
        <DeletedObjectState />
      </section>
    );

  return (
    <section className="run-screen" data-run-id={runId}>
      <header className="run-header">
        <div className="run-title">
          <h2>
            {t("run.title")}
            {run ? (
              <span className={`status ${run.status}`}>{t(RUN_STATUS_LABEL[run.status])}</span>
            ) : null}
          </h2>
          {run?.threadId ? (
            <a href={threadHref(run.threadId)} className="small">
              {t("run.openConversation")}
            </a>
          ) : null}
          {run && tune ? (
            <a
              href={runHref(run.id)}
              className="small"
              data-testid="run-timeline-link"
              onClick={(event) => {
                event.preventDefault();
                showTimeline();
              }}
            >
              {t("run.timelineLink")}
            </a>
          ) : null}
          {run && tune ? <AnalyticsRunLink api={api} runId={run.id} /> : null}
          {run && !isTerminal(run.status) && canCancel.allowed ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              {t("run.cancel")}
            </Button>
          ) : null}
        </div>
        {run ? (
          <p className="run-lede muted small">
            {bot ? <strong>{bot.name}</strong> : null}
            {trigger ? <span>{t("runStory.startedBy", { trigger: t(trigger) })}</span> : null}
            {run.startedAt ? (
              <span>
                {/* The startup timeline it points to is part of the tune view. */}
                {tune
                  ? t("run.timingWhere", {
                      duration: formatDuration(run.startedAt, run.finishedAt),
                    })
                  : formatDuration(run.startedAt, run.finishedAt)}
              </span>
            ) : null}
          </p>
        ) : null}
        {run && !isTerminal(run.status) ? (
          <RoleNote
            action="run.cancel"
            allowed={canCancel.allowed}
            does={t("run.roleNote.cancel")}
          />
        ) : null}
        {run && (botLookupFailed || threadLookupFailed) ? (
          <div role="alert" className="run-lookup-error">
            <p>{t("run.lookupFailed")}</p>
            <Button onClick={() => setLookupRevision((value) => value + 1)}>
              {t("run.retryLookup")}
            </Button>
          </div>
        ) : null}
        {error ? (
          <div role="alert">
            <p className="error">{error}</p>
            <Button onClick={() => setLoadRevision((value) => value + 1)}>{t("run.reload")}</Button>
          </div>
        ) : null}
        {run?.error ? (
          <output className="notice danger">{describeRunError(run.error)}</output>
        ) : null}
      </header>
      {run ? (
        <RunStory
          events={state.events}
          live={live}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={() => void loadOlder()}
        />
      ) : error ? null : (
        <p className="muted" aria-busy="true">
          {t("run.loading")}
        </p>
      )}
      <details hidden={!run} className="run-metadata" open={waitingContinuation} ref={detailsRef}>
        <summary>{t("runStory.details")}</summary>
        {run && waitingContinuation ? (
          <RunContextPanel
            api={api}
            run={run}
            events={state.events}
            canContinue={canContinue.allowed}
            onRunChanged={(updated) => dispatch({ type: "run_status", run: updated })}
          />
        ) : null}
        {run ? (
          <dl className="run-facts">
            <dt>{t("run.fact.bot")}</dt>
            <dd>
              {bot ? `${bot.name} ` : null}
              <code>{run.botId}</code>
            </dd>
            <dt>{t("runStory.runId")}</dt>
            <dd>
              <code>{run.id}</code>
            </dd>
            <dt>{t("run.fact.lane")}</dt>
            <dd>{t(LANE_LABEL[run.lane])}</dd>
            <dt>{t("run.fact.trigger")}</dt>
            <dd>
              {t(TRIGGER_LABEL[run.triggerKind])} <code className="muted">{run.triggerRef}</code>
            </dd>
            {run.threadId ? (
              <>
                <dt>{t("run.fact.thread")}</dt>
                <dd>
                  <a href={threadHref(run.threadId)}>{run.threadId}</a>
                </dd>
              </>
            ) : null}
            <dt>{t("run.fact.created")}</dt>
            <dd>{formatDateTime(run.createdAt)}</dd>
            <dt>{t("run.fact.started")}</dt>
            <dd>{formatDateTime(run.startedAt)}</dd>
            <dt>{t("run.fact.finished")}</dt>
            <dd>
              {formatDateTime(run.finishedAt)}
              {run.startedAt ? (
                <span className="muted small">
                  {" "}
                  ({formatDuration(run.startedAt, run.finishedAt)})
                </span>
              ) : null}
            </dd>
            {run.summary ? (
              <>
                <dt>{t("run.fact.summary")}</dt>
                <dd>
                  <p>{run.summary.done}</p>
                  {run.summary.reply ? (
                    <blockquote className="md">
                      <Markdown text={run.summary.reply} />
                    </blockquote>
                  ) : null}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="muted">{t("run.loading")}</p>
        )}
        {!tune ? null : (
          <>
            <h3>{t("run.usage.heading")}</h3>
            {state.usageCoverage ? <p>{t(`run.usage.${state.usageCoverage}`)}</p> : null}
            {state.usage.length === 0 ? (
              <p className="muted small">
                {run && !isTerminal(run.status) ? t("run.usage.noneYet") : t("run.usage.none")}
              </p>
            ) : (
              <Table className="usage" aria-label={t("run.usage.heading")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("run.usage.model")}</TableHead>
                    <TableHead>{t("run.usage.input")}</TableHead>
                    <TableHead>{t("run.usage.output")}</TableHead>
                    <TableHead>{t("run.usage.cacheRead")}</TableHead>
                    <TableHead>{t("run.usage.cacheCreate")}</TableHead>
                    <TableHead>{t("run.usage.cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.usage.map((u) => (
                    <TableRow key={u.model}>
                      <TableCell>
                        <code>{u.model}</code>
                        {u.coverage === "partial" ? ` (${t("run.usage.partial")})` : ""}
                      </TableCell>
                      <TableCell>{u.inputTokens ?? "—"}</TableCell>
                      <TableCell>{u.outputTokens ?? "—"}</TableCell>
                      <TableCell>{u.cacheReadTokens ?? "—"}</TableCell>
                      <TableCell>{u.cacheCreateTokens ?? "—"}</TableCell>
                      <TableCell>
                        {formatCost(u.costUsd)}
                        {u.attributionUncertain ? (
                          <p>{t("run.usage.attributionUncertain")}</p>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
        {run && tune && !waitingContinuation ? (
          <RunContextPanel
            api={api}
            run={run}
            events={state.events}
            canContinue={canContinue.allowed}
            onRunChanged={(updated) => dispatch({ type: "run_status", run: updated })}
          />
        ) : null}
        {run && tune ? (
          <section
            className="management-subsection"
            ref={timelineRef}
            tabIndex={-1}
            data-testid="run-startup-timeline"
          >
            <h3>{t("runTimeline.heading")}</h3>
            <RunTimelinePanel api={api} run={run} />
          </section>
        ) : null}
        {tune && spanCount > 0 ? (
          <section className="management-subsection">
            <h3>{t("phaseTiming.heading", { count: spanCount })}</h3>
            <PhaseTimingTimeline events={state.events} />
          </section>
        ) : null}
        {run ? <RunChangesSection api={api} run={run} /> : null}
      </details>
      {!tune ? null : (
        <details className="run-metadata run-log">
          <summary>{t("runStory.technicalLog", { count: state.events.length })}</summary>
          <div className="events-toolbar">
            <span className="muted small">
              {shown !== state.events.length
                ? t("run.events.visibleOfTotal", {
                    visible: shown,
                    total: state.events.length,
                  })
                : `(${state.events.length})`}
            </span>
            {hasOlder ? (
              <Button size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? t("run.events.loadingOlder") : t("run.events.loadOlder")}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setOldestFirst((value) => !value)}>
              {oldestFirst ? t("run.events.newestFirst") : t("run.events.oldestFirst")}
            </Button>
            {diagnosticCount > 0 ? (
              <label className="small">
                <input
                  type="checkbox"
                  checked={showDiagnostics}
                  onChange={(event) => setShowDiagnostics(event.currentTarget.checked)}
                />{" "}
                {t("run.events.showDiagnostics", { count: diagnosticCount })}
              </label>
            ) : null}
          </div>
          <ol className="events" aria-label={t("run.events.list")}>
            {(oldestFirst ? rows : [...rows].reverse()).map((row) =>
              row.kind === "tool" ? (
                <ToolCallRow key={row.call.seq} row={row} evidenceUrl={evidenceUrl} />
              ) : (
                <RunEventRow key={row.event.seq} event={row.event} evidenceUrl={evidenceUrl} />
              ),
            )}
          </ol>
        </details>
      )}
    </section>
  );
}
