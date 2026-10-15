// Runs: the ledger list, one run with its usage, its events, context metrics and the operator's
// continuation and cancel decisions.

import type {
  BotId,
  RunContextMetrics,
  RunEvent,
  RunId,
  RunTimeline,
  RunUsageReceipt,
  ThreadId,
  UsageCoverage,
  WorkspaceId,
} from "@deskmates/contracts";
import type { RunView } from "../../api/types.js";
import { type HttpTransport, query } from "../../platform/http-transport.js";

/** Which runs a run list holds (#113 slice R): unfinished runs come whole, finished ones paged. */
export interface RunListFilter {
  threadId?: ThreadId;
  botId?: BotId;
  workspaceId?: WorkspaceId;
  phase?: "active" | "finished";
  cursor?: string;
  limit?: number;
}

/** One page of runs, newest first; `nextCursor` means older runs exist. */
export interface RunPage {
  runs: RunView[];
  nextCursor?: string;
}

/** A bounded slice of a run's events in `seq` order (#113 slice R). */
export interface RunEventSlice {
  events: RunEvent[];
  /** A tail (`afterSeq`) stopped short: ask again after its last event. */
  hasMore?: boolean;
  /** A window stopped short: older events exist before its first one. */
  hasOlder?: boolean;
}

/** The newest memory index observation of a workspace, for Learned memory. */
export interface MemoryIndexObservation {
  runId: RunId;
  counts: Record<string, number>;
}

export interface RunsApi {
  /** Moves a non-terminal run to `cancelled`; a finished run is refused with its status. */
  cancelRun(id: RunId): Promise<{ run: RunView }>;
  decideContinuation(id: RunId, decision: "continue" | "stop"): Promise<{ run: RunView }>;
  getRun(id: RunId): Promise<{
    run: RunView;
    usage: RunUsageReceipt[];
    usageCoverage?: UsageCoverage;
  }>;
  getRunContext(id: RunId): Promise<RunContextMetrics>;
  /** The run's per-attempt startup timeline, derived from its whole ledger (ADR-0037). */
  getRunTimeline(id: RunId): Promise<RunTimeline>;
  /** The run's newest screenshot event, or null when it took none (issue #9). */
  latestRunScreenshot(id: RunId): Promise<RunEvent | null>;
  /** Each bot's newest run in one workspace (replaces a tenant-wide run read). */
  latestRunsByBot(workspaceId: WorkspaceId): Promise<RunView[]>;
  /** The newest run's events, or a bounded tail after `afterSeq`. */
  listRunEvents(id: RunId, afterSeq?: number): Promise<RunEvent[]>;
  listRunEventSlice(
    id: RunId,
    slice?: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): Promise<RunEventSlice>;
  listRuns(filter?: RunListFilter): Promise<RunPage>;
  memoryIndexObservation(workspaceId: WorkspaceId): Promise<MemoryIndexObservation | null>;
}

export function createRunsApi(t: HttpTransport): RunsApi {
  return {
    cancelRun(id) {
      return t.json("POST", `/api/runs/${encodeURIComponent(id)}/cancel`, {});
    },
    decideContinuation(id, decision) {
      return t.json("POST", `/api/runs/${encodeURIComponent(id)}/continuation/decide`, {
        decision,
      });
    },
    getRun(id) {
      return t.json("GET", `/api/runs/${encodeURIComponent(id)}`);
    },
    getRunContext(id) {
      return t.json("GET", `/api/runs/${encodeURIComponent(id)}/context`);
    },
    getRunTimeline(id) {
      return t.json("GET", `/api/runs/${encodeURIComponent(id)}/timeline`);
    },
    async latestRunScreenshot(id) {
      const r = await t.json<{ screenshot: RunEvent | null }>(
        "GET",
        `/api/runs/${encodeURIComponent(id)}/screenshot`,
      );
      return r.screenshot;
    },
    async latestRunsByBot(workspaceId) {
      const r = await t.json<{ runs: RunView[] }>(
        "GET",
        `/api/runs/latest-by-bot${query({ workspaceId })}`,
      );
      return r.runs;
    },
    async listRunEvents(id, afterSeq) {
      const r = await t.json<{ events: RunEvent[] }>(
        "GET",
        `/api/runs/${encodeURIComponent(id)}/events${query({ afterSeq })}`,
      );
      return r.events;
    },
    listRunEventSlice(id, slice = {}) {
      return t.json(
        "GET",
        `/api/runs/${encodeURIComponent(id)}/events${query({
          afterSeq: slice.afterSeq,
          beforeSeq: slice.beforeSeq,
          limit: slice.limit,
        })}`,
      );
    },
    listRuns(filter = {}) {
      return t.json(
        "GET",
        `/api/runs${query({
          threadId: filter.threadId,
          botId: filter.botId,
          workspaceId: filter.workspaceId,
          phase: filter.phase,
          cursor: filter.cursor,
          limit: filter.limit,
        })}`,
      );
    },
    async memoryIndexObservation(workspaceId) {
      const r = await t.json<{ observation: MemoryIndexObservation | null }>(
        "GET",
        `/api/runs/memory-index${query({ workspaceId })}`,
      );
      return r.observation;
    },
  };
}
