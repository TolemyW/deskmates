// View state for one run replay: header, usage and the event list in `seq` order. Frames for
// other runs are ignored so one thread-scoped SSE stream can feed the screen.

import type { RunEvent, RunId, RunUsageReceipt } from "@deskmates/contracts";
import type { GatewayEvent, RunView } from "../api/types.js";
import { newerRun } from "./newer-run.js";

export interface RunViewState {
  runId: RunId;
  run?: RunView;
  usage: readonly RunUsageReceipt[];
  usageCoverage?: import("@deskmates/contracts").UsageCoverage | undefined;
  events: readonly RunEvent[];
}

export type RunViewAction =
  | {
      type: "loaded";
      run: RunView;
      usage: readonly RunUsageReceipt[];
      usageCoverage?: import("@deskmates/contracts").UsageCoverage | undefined;
      events: readonly RunEvent[];
    }
  | GatewayEvent;

export function initialRunView(runId: RunId): RunViewState {
  return { runId, usage: [], events: [] };
}

export function sortEvents(events: readonly RunEvent[]): RunEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

function insertBySeq(list: readonly RunEvent[], e: RunEvent): readonly RunEvent[] {
  if (list.some((x) => x.seq === e.seq)) return list;
  return sortEvents([...list, e]);
}

export function runViewReducer(state: RunViewState, action: RunViewAction): RunViewState {
  switch (action.type) {
    case "loaded": {
      if (action.run.id !== state.runId) return state;
      const run = newerRun(state.run, action.run);
      return {
        ...state,
        // A status change that arrived over SSE while the fetch was in flight outranks the
        // stale row the fetch returned.
        run,
        // Usage belongs to the same snapshot as its run row. An older attempt or a
        // pre-terminal response cannot replace the accounting already shown for a newer run.
        usage: run === action.run ? action.usage : state.usage,
        usageCoverage: run === action.run ? action.usageCoverage : state.usageCoverage,
        // Events that arrived over SSE while the fetch was in flight are kept.
        events: action.events.reduce<readonly RunEvent[]>(insertBySeq, state.events),
      };
    }
    case "run_status":
      if (action.run.id !== state.runId) return state;
      return { ...state, run: newerRun(state.run, action.run) };
    case "run_event":
      if (action.event.runId !== state.runId) return state;
      return { ...state, events: insertBySeq(state.events, action.event) };
    case "thread_message":
      return state;
    default:
      return state;
  }
}
