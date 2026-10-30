// View state for one thread: the transcript plus the runs it triggered. A pure reducer so the
// SSE frames and the initial fetch apply the same way and can be tested without React.

import {
  type Approval,
  type RunId,
  type RunStatus,
  type ThreadMessage,
  isTerminal,
} from "@deskmates/contracts";
import type { GatewayEvent, RunView } from "../api/types.js";
import type { MessageKey } from "../i18n/catalogs.js";
import { currentI18n } from "../i18n/intl.js";
import { newerApproval } from "./newer-approval.js";
import { newerRun } from "./newer-run.js";

export interface ThreadViewState {
  messages: readonly ThreadMessage[];
  runs: Readonly<Record<string, RunView>>;
  /** Monotonic local order of live run updates, used to reject older HTTP snapshots. */
  runRevision: number;
  /** Last live revision for each run id. HTTP loads never advance this map. */
  liveRunRevisions: Readonly<Record<string, number>>;
  /** Approvals referenced by the transcript, by id; the card joins them to their system message. */
  approvals: Readonly<Record<string, Approval>>;
}

export type ThreadViewAction =
  /** A fetch landed: merged in, never substituted for what the stream already delivered. */
  | {
      type: "loaded";
      messages: readonly ThreadMessage[];
      runs: readonly RunView[];
      approvals?: readonly Approval[];
      /** `runRevision` captured immediately before this HTTP request started. */
      runSnapshotRevision?: number;
    }
  /** Switching threads: the only action that throws state away. */
  | { type: "reset" }
  | GatewayEvent;

export const EMPTY_THREAD_VIEW: ThreadViewState = {
  messages: [],
  runs: {},
  runRevision: 0,
  liveRunRevisions: {},
  approvals: {},
};

function insertBySeq(list: readonly ThreadMessage[], m: ThreadMessage): readonly ThreadMessage[] {
  if (list.some((x) => x.id === m.id || x.seq === m.seq)) return list;
  const out = [...list, m];
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function threadViewReducer(
  state: ThreadViewState,
  action: ThreadViewAction,
): ThreadViewState {
  switch (action.type) {
    case "reset":
      return EMPTY_THREAD_VIEW;
    case "loaded": {
      // The fetch may have been in flight while frames arrived, and a refetch after a stream gap
      // only asks for what is missing. Merge both ways: a reply delivered over SSE must not be
      // dropped, and a run that finished over SSE must not go back to "running" and strand the
      // typing indicator.
      const messages = action.messages.reduce<readonly ThreadMessage[]>(
        (list, m) => insertBySeq(list, m),
        state.messages,
      );
      const runs: Record<string, RunView> = { ...state.runs };
      for (const r of action.runs) {
        const liveRevision = state.liveRunRevisions[r.id] ?? 0;
        // A live update received after this request began is newer than its HTTP snapshot,
        // including legal non-terminal cycles such as waiting_approval_live → running.
        if (action.runSnapshotRevision !== undefined && liveRevision > action.runSnapshotRevision) {
          continue;
        }
        runs[r.id] = newerRun(runs[r.id], r);
      }
      const approvals: Record<string, Approval> = { ...state.approvals };
      for (const a of action.approvals ?? []) approvals[a.id] = newerApproval(approvals[a.id], a);
      return { ...state, messages, runs, approvals };
    }
    case "thread_message":
      return { ...state, messages: insertBySeq(state.messages, action.message) };
    case "run_status": {
      const runRevision = state.runRevision + 1;
      return {
        ...state,
        runs: { ...state.runs, [action.run.id]: newerRun(state.runs[action.run.id], action.run) },
        runRevision,
        liveRunRevisions: { ...state.liveRunRevisions, [action.run.id]: runRevision },
      };
    }
    case "approval":
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [action.approval.id]: newerApproval(state.approvals[action.approval.id], action.approval),
        },
      };
    case "run_event":
      // The transcript does not show ledger events; the run replay screen does.
      return state;
    default:
      return state;
  }
}

/** Runs that have not finished, oldest first: what the typing indicator reports. */
export function activeRuns(state: ThreadViewState): RunView[] {
  return Object.values(state.runs)
    .filter((r) => !isTerminal(r.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Failed/cancelled runs remain visible even when no bot reply was published. */
export function unsuccessfulRuns(state: ThreadViewState): RunView[] {
  return Object.values(state.runs)
    .filter(
      (run) => run.status === "failed" || run.status === "cancelled" || run.status === "stopped",
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type TranscriptItem =
  | { kind: "message"; message: ThreadViewState["messages"][number] }
  | { kind: "outcome"; run: RunView }
  /** A one-member chat's bot at work in another conversation or on a background task. */
  | { kind: "elsewhere"; run: RunView };

/**
 * Messages in seq order with each failed or cancelled run placed after the last message sent
 * before that run ended, and each finished run from elsewhere placed the same way; a run from
 * elsewhere still in progress comes last, oldest first. Listing outcomes after the whole
 * transcript made an old, already fixed failure look like the newest event in the thread, and
 * listing finished work from elsewhere below the newest message made yesterday's task read as
 * the answer to today's question.
 */
export function transcriptTimeline(
  state: ThreadViewState,
  partial = false,
  elsewhere: readonly RunView[] = [],
): TranscriptItem[] {
  // A transcript that starts mid-history (#113 slice CH) shows no card from before its first
  // loaded message; Load older brings those back with their messages.
  const from = partial ? (state.messages[0]?.ts ?? "") : "";
  const endedAt = (run: RunView) => run.finishedAt ?? run.startedAt ?? run.createdAt;
  const timed = [
    ...unsuccessfulRuns(state).map((run) => ({ item: { kind: "outcome" as const, run }, run })),
    ...elsewhere
      .filter((run) => isTerminal(run.status))
      .map((run) => ({ item: { kind: "elsewhere" as const, run }, run })),
  ]
    .map(({ item, run }) => ({ item, at: endedAt(run) }))
    .filter((entry) => entry.at >= from)
    .sort((a, b) => a.at.localeCompare(b.at));
  const items: TranscriptItem[] = [];
  let next = 0;
  for (const message of state.messages) {
    while (next < timed.length && (timed[next]?.at ?? "") < message.ts) {
      items.push((timed[next] as { item: TranscriptItem }).item);
      next += 1;
    }
    items.push({ kind: "message", message });
  }
  for (; next < timed.length; next += 1) {
    items.push((timed[next] as { item: TranscriptItem }).item);
  }
  for (const run of elsewhere
    .filter((run) => !isTerminal(run.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    items.push({ kind: "elsewhere", run });
  }
  return items;
}

/** Most recently created run for one bot, with insertion order breaking equal timestamps. */
export function latestRunForBot(state: ThreadViewState, botId: string): RunView | undefined {
  let latest: RunView | undefined;
  for (const run of Object.values(state.runs)) {
    if (run.botId !== botId) continue;
    if (!latest || run.createdAt >= latest.createdAt) latest = run;
  }
  return latest;
}

export function runById(state: ThreadViewState, id: RunId | undefined): RunView | undefined {
  return id === undefined ? undefined : state.runs[id];
}

/** A run status as words; English is the status with spaces for underscores. */
const RUN_STATUS_LABELS: Readonly<Record<RunStatus, MessageKey>> = {
  queued: "chatPane.runStatus.queued",
  running: "chatPane.runStatus.running",
  stalled: "chatPane.runStatus.stalled",
  waiting_approval_live: "chatPane.runStatus.waiting_approval_live",
  waiting_approval: "chatPane.runStatus.waiting_approval",
  waiting_browser: "chatPane.runStatus.waiting_browser",
  waiting_continuation: "chatPane.runStatus.waiting_continuation",
  waiting_platform: "chatPane.runStatus.waiting_platform",
  succeeded: "chatPane.runStatus.succeeded",
  silent: "chatPane.runStatus.silent",
  failed: "chatPane.runStatus.failed",
  cancelled: "chatPane.runStatus.cancelled",
  stopped: "chatPane.runStatus.stopped",
};

export function runStatusLabel(status: RunStatus): string {
  const key = RUN_STATUS_LABELS[status];
  return key ? currentI18n().t(key) : status.replaceAll("_", " ");
}
