import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@deskmates/ui";
// Run replay screen (M0): header with status, lane, trigger, timestamps and priced usage, then
// the ledger events in `seq` order, appended live over SSE while the run is still going. Issue
// #9: a tool call and its result are one row, phase timing is its own timeline, and diagnostic
// log rows are collapsed until asked for (`ledger-rows.ts`).

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
import type { GatewayEvent } from "../../api/types.js";
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
import { Markdown } from "../../lib/markdown.js";
import { threadHref } from "../../router.js";
import { initialRunView, runViewReducer } from "../../state/run-view.js";
import { RoleNote, useCan, useCanInOwnSideChat } from "../../state/session-roles.js";
import { eventsShown, isDiagnosticEvent, ledgerRows } from "./ledger-rows.js";
import { PhaseTimingTimeline, phaseSpans } from "./phase-timing.js";
import { RunContextPanel } from "./run-context-panel.js";
import { RunEventRow } from "./run-event-row.js";
import { RunTimelinePanel } from "./run-timeline.js";
import { ToolCallRow } from "./tool-call-row.js";

/** A run's status as the pill shows it; the English is the status code itself. */
const RUN_STATUS_LABEL: Readonly<Record<RunStatus, MessageKey>> = {
  queued: "run.status.queued",
  running: "run.status.running",
  stalled: "run.status.stalled",
  waiting_approval_live: "run.status.waitingApprovalLive",
  waiting_approval: "run.status.waitingApproval",
  waiting_browser: "run.status.waitingBrowser",
  waiting_continuation: "run.status.waitingContinuation",
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
  const [state, dispatch] = useReducer(runViewReducer, runId, initialRunView);
  const [error, setError] = useState<string | undefined>();
  const [oldestFirst, setOldestFirst] = useState(false);
  // #113 slice R: the replay opens on the newest events; older ones load on request.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The subscription callbacks outlive a render, so the refetch reads the event list from a ref.
  const stateRef = useRef(state);
  stateRef.current = state;

  // The stream is opened before the first fetch: subscribing afterwards drops every frame emitted
  // in between, and a short run can finish there. The reducer merges, so an overlap is free but a
  // gap is not. The stream starts unfiltered because the run's thread is only known once `getRun`
  // answers; it is then narrowed to that thread, and the unfiltered one is closed only after the
  // narrowed one is open so the swap has no gap of its own. Cron and webhook runs have no thread
  // and stay on the unfiltered stream, where the reducer drops other runs' frames.
  useEffect(() => {
    let cancelled = false;
    let stopWide: (() => void) | undefined;
    let stopScoped: (() => void) | undefined;

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
      void refetch().catch(() => {
        // A failed gap recovery is not worth replacing the screen with an error; the next
        // reconnect or the terminal refetch tries again.
      });
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
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      stopWide?.();
      stopScoped?.();
    };
  }, [runId, api]);

  // Usage is only written at the end of a run, so refetch once the status turns terminal.
  const status = state.run?.status;
  useEffect(() => {
    if (
      !status ||
      (!isTerminal(status) && status !== "waiting_continuation" && status !== "waiting_approval")
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
  const [evidenceWorkspace, setEvidenceWorkspace] = useState<WorkspaceId>();
  const evidenceBotId = run?.botId;
  const hasEvidence = state.events.some(
    (event) => event.kind === "tool_result" && event.payload.evidence,
  );
  useEffect(() => {
    let cancelled = false;
    if (hasEvidence && evidenceBotId) {
      // #113 §3.2: the one bot this run names, not the whole roster.
      void api
        .listBotsByIds([evidenceBotId])
        .then((bots) => {
          if (!cancelled)
            setEvidenceWorkspace(bots.find((bot) => bot.id === evidenceBotId)?.workspaceId);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [api, evidenceBotId, hasEvidence]);
  // A Member stops or continues only the runs of their own side chat (ADR-0022 amendment 1
  // A11/A12); the thread is fetched only for a role that needs the answer. The Gateway decides.
  const managesRuns = useCan("run.cancel").allowed;
  const [runThread, setRunThread] = useState<{ thread: Thread; memberCount: number }>();
  const runThreadId = run?.threadId;
  useEffect(() => {
    if (managesRuns || runThreadId === undefined) return;
    let active = true;
    api
      .getThread(runThreadId)
      .then((detail) => {
        if (active) setRunThread({ thread: detail.thread, memberCount: detail.members.length });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, managesRuns, runThreadId]);
  const canCancel = useCanInOwnSideChat(
    "run.cancel",
    runThread?.thread,
    runThread?.memberCount ?? 0,
  );
  const canContinue = useCanInOwnSideChat(
    "run.continue",
    runThread?.thread,
    runThread?.memberCount ?? 0,
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

  return (
    <section className="run-screen">
      <header className="run-header">
        <div className="run-title">
          <h2>
            {t("run.title")}
            {run ? (
              <span className={`status ${run.status}`}>
                {RUN_STATUS_LABEL[run.status] ? t(RUN_STATUS_LABEL[run.status]) : run.status}
              </span>
            ) : null}
            <code>{runId}</code>
          </h2>
          {run?.threadId ? (
            <a href={threadHref(run.threadId)} className="small">
              {t("run.openConversation")}
            </a>
          ) : null}
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
        {run && !isTerminal(run.status) ? (
          <RoleNote
            action="run.cancel"
            allowed={canCancel.allowed}
            does={t("run.roleNote.cancel")}
          />
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        {run?.error ? (
          <output className="notice danger">{describeRunError(run.error)}</output>
        ) : null}
        <details className="run-metadata">
          <summary>{t("run.details")}</summary>
          {run ? (
            <dl className="run-facts">
              <dt>{t("run.fact.bot")}</dt>
              <dd>
                <code>{run.botId}</code>
              </dd>
              <dt>{t("run.fact.lane")}</dt>
              <dd>{LANE_LABEL[run.lane] ? t(LANE_LABEL[run.lane]) : run.lane}</dd>
              <dt>{t("run.fact.trigger")}</dt>
              <dd>
                {TRIGGER_LABEL[run.triggerKind]
                  ? t(TRIGGER_LABEL[run.triggerKind])
                  : run.triggerKind}{" "}
                <code className="muted">{run.triggerRef}</code>
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
                      {u.attributionUncertain ? <p>{t("run.usage.attributionUncertain")}</p> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </details>
      </header>
      {run ? (
        <details className="run-metadata" open={run.status === "waiting_continuation"}>
          <summary>{t("runContextPanel.heading")}</summary>
          <RunContextPanel
            api={api}
            run={run}
            events={state.events}
            canContinue={canContinue.allowed}
            onRunChanged={(updated) => dispatch({ type: "run_status", run: updated })}
          />
        </details>
      ) : null}
      {run ? (
        <details className="run-metadata">
          <summary>{t("runTimeline.heading")}</summary>
          <RunTimelinePanel api={api} run={run} />
        </details>
      ) : null}
      {spanCount > 0 ? (
        <details className="run-metadata">
          <summary>{t("phaseTiming.heading", { count: spanCount })}</summary>
          <PhaseTimingTimeline events={state.events} />
        </details>
      ) : null}
      <h3>
        {t("run.events.heading")}{" "}
        <span className="muted small">
          {shown !== state.events.length
            ? t("run.events.visibleOfTotal", {
                visible: shown,
                total: state.events.length,
              })
            : `(${state.events.length})`}
        </span>
      </h3>
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
      <ol className="events" aria-label={t("run.events.list")}>
        {(oldestFirst ? rows : [...rows].reverse()).map((row) =>
          row.kind === "tool" ? (
            <ToolCallRow key={row.call.seq} row={row} evidenceUrl={evidenceUrl} />
          ) : (
            <RunEventRow key={row.event.seq} event={row.event} evidenceUrl={evidenceUrl} />
          ),
        )}
      </ol>
    </section>
  );
}
