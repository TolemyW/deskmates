// Runs: the ledger list, one run with its usage, its events, context metrics and the operator's
// continuation and cancel decisions.

import type {
  BotId,
  RunChanges,
  RunContextMetrics,
  RunEvent,
  RunFailureClass,
  RunId,
  RunLane,
  RunMark,
  RunStatus,
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
  /** The runs index (issue #11, ADR-0042 decision 2): these statuses only. */
  status?: readonly RunStatus[];
  lane?: RunLane;
  /** `createdAt` at or after this ISO time. */
  since?: string;
  /** `createdAt` before this ISO time. */
  until?: string;
  failureClass?: RunFailureClass;
  /** Case-insensitive text in the run's error. */
  q?: string;
}

/** One memory version a run's model context was given (ADR-0011 A13). */
export interface RunSuppliedMemoryVersion {
  entryId: string;
  version: number;
  via: string;
  suppliedAt: string;
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
  /** What the run changed beyond its row: approvals, task records, memory written (ADR-0042). */
  getRunChanges(id: RunId): Promise<RunChanges>;
  getRunContext(id: RunId): Promise<RunContextMetrics>;
  /** The run's per-attempt startup timeline, derived from its whole ledger (ADR-0037). */
  getRunTimeline(id: RunId): Promise<RunTimeline>;
  /** Each bot's newest run in one workspace (replaces a tenant-wide run read). */
  latestRunsByBot(workspaceId: WorkspaceId): Promise<RunView[]>;
  /** The newest run's events, or a bounded tail after `afterSeq`. */
  listRunEvents(id: RunId, afterSeq?: number): Promise<RunEvent[]>;
  listRunEventSlice(
    id: RunId,
    slice?: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): Promise<RunEventSlice>;
  /** The memory versions the run's context was given. */
  listRunMemoryVersions(id: RunId): Promise<RunSuppliedMemoryVersion[]>;
  listRuns(filter?: RunListFilter): Promise<RunPage>;
  /** Marks the run wrong, or replaces its note (ADR-0042 decision 3; Owner or Admin). */
  markRun(id: RunId, note?: string): Promise<RunMark>;
  memoryIndexObservation(workspaceId: WorkspaceId): Promise<MemoryIndexObservation | null>;
  /** Removes the run's mark; whether there was one. */
  unmarkRun(id: RunId): Promise<boolean>;
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
    getRunChanges(id) {
      return t.json("GET", `/api/runs/${encodeURIComponent(id)}/changes`);
    },
    getRunContext(id) {
      return t.json("GET", `/api/runs/${encodeURIComponent(id)}/context`);
    },
    getRunTimeline(id) {
      return t.json("GET", `/api/runs/${encodeURIComponent(id)}/timeline`);
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
    async listRunMemoryVersions(id) {
      const r = await t.json<{ versions: RunSuppliedMemoryVersion[] }>(
        "GET",
        `/api/runs/${encodeURIComponent(id)}/memory-versions`,
      );
      return r.versions;
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
          status: filter.status && filter.status.length > 0 ? filter.status.join(",") : undefined,
          lane: filter.lane,
          since: filter.since,
          until: filter.until,
          failureClass: filter.failureClass,
          q: filter.q,
        })}`,
      );
    },
    async markRun(id, note) {
      const r = await t.json<{ mark: RunMark }>(
        "PUT",
        `/api/runs/${encodeURIComponent(id)}/mark`,
        note === undefined ? {} : { note },
      );
      return r.mark;
    },
    async memoryIndexObservation(workspaceId) {
      const r = await t.json<{ observation: MemoryIndexObservation | null }>(
        "GET",
        `/api/runs/memory-index${query({ workspaceId })}`,
      );
      return r.observation;
    },
    async unmarkRun(id) {
      const r = await t.json<{ removed: boolean }>(
        "DELETE",
        `/api/runs/${encodeURIComponent(id)}/mark`,
      );
      return r.removed;
    },
  };
}
