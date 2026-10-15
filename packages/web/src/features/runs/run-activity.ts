// What a live run is doing now, derived from its ledger events (issue #9). No new event kinds: an
// open `tool_call` (no `tool_result` with its `toolUseId` yet) is a tool at work, and a Gateway
// `model_first_byte` span that has started but not ended is a model request still waiting for
// its first byte. Opens and closes are kept as sets, so events applied in any order, twice, or
// from a fetched tail merged with live frames give the same answer. Pure, so the chat row, the
// run screen and the tests read the same thing.

import type { RunEvent, RunId } from "@deskmates/contracts";
import { currentI18n } from "../../i18n/intl.js";

interface Opened {
  /** Tool name for a tool call; absent for a model request. */
  toolName?: string;
  since: string;
}

/** One run's open and closed work, as far as the events seen so far show it. */
export interface RunActivityState {
  /** Tool calls by `toolUseId`. */
  tools: Readonly<Record<string, Opened>>;
  toolsClosed: ReadonlySet<string>;
  /** Model requests waiting for their first byte, by request span id. */
  modelWaits: Readonly<Record<string, Opened>>;
  modelWaitsClosed: ReadonlySet<string>;
}

export type RunActivity =
  | { kind: "tool"; toolName: string; since: string }
  | { kind: "model"; since: string };

export const EMPTY_RUN_ACTIVITY: RunActivityState = {
  tools: {},
  toolsClosed: new Set(),
  modelWaits: {},
  modelWaitsClosed: new Set(),
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function close(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return set.has(id) ? set : new Set([...set, id]);
}

/** The request span a phase-timing sample belongs to, when it says anything about a model wait. */
function modelRequestOf(p: Record<string, unknown>): string | undefined {
  if (p.source !== "phase_timing" || p.requestKind === "count_tokens") return undefined;
  if (p.phase === "model_first_byte") return str(p.parentSpanId);
  if (p.phase === "model_request" && p.edge === "end") return str(p.spanId);
  return undefined;
}

/** Applies one ledger event of the run; anything that is not open or closed work is ignored. */
export function applyRunActivity(state: RunActivityState, event: RunEvent): RunActivityState {
  const p = event.payload;
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    const id = str(p.toolUseId);
    if (!id) return state;
    if (event.kind === "tool_result")
      return { ...state, toolsClosed: close(state.toolsClosed, id) };
    if (state.tools[id]) return state;
    return {
      ...state,
      tools: { ...state.tools, [id]: { toolName: str(p.toolName) ?? "?", since: event.ts } },
    };
  }
  if (event.kind !== "log") return state;
  const request = modelRequestOf(p);
  if (!request) return state;
  if (p.phase === "model_first_byte" && p.edge === "start") {
    if (state.modelWaits[request]) return state;
    return {
      ...state,
      modelWaits: { ...state.modelWaits, [request]: { since: str(p.at) ?? event.ts } },
    };
  }
  return { ...state, modelWaitsClosed: close(state.modelWaitsClosed, request) };
}

/** Folds a list of events into one state. */
export function runActivityOf(
  events: readonly RunEvent[],
  from: RunActivityState = EMPTY_RUN_ACTIVITY,
): RunActivityState {
  return events.reduce(applyRunActivity, from);
}

function open(opened: Readonly<Record<string, Opened>>, closed: ReadonlySet<string>): Opened[] {
  return Object.entries(opened)
    .filter(([id]) => !closed.has(id))
    .map(([, value]) => value);
}

/**
 * The one thing to say about the run now: the newest open tool call, else the oldest model
 * request still waiting for its first byte, else nothing (the model is streaming its answer, or
 * the sidecar is between steps).
 */
export function currentActivity(state: RunActivityState | undefined): RunActivity | undefined {
  if (!state) return undefined;
  const tool = open(state.tools, state.toolsClosed).sort((a, b) =>
    b.since.localeCompare(a.since),
  )[0];
  if (tool) return { kind: "tool", toolName: tool.toolName ?? "?", since: tool.since };
  const wait = open(state.modelWaits, state.modelWaitsClosed).sort((a, b) =>
    a.since.localeCompare(b.since),
  )[0];
  return wait ? { kind: "model", since: wait.since } : undefined;
}

/** A tool's name as people read it: an MCP tool without its `mcp__<server>__` prefix. */
export function shortToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const tool = name.slice("mcp__".length).split("__").slice(1).join("__");
  return tool === "" ? name : tool;
}

/** Milliseconds since `since`, never negative (the browser's clock may trail the Gateway's). */
export function elapsedMs(since: string | undefined, now: number): number {
  if (!since) return 0;
  const start = Date.parse(since);
  return Number.isNaN(start) ? 0 : Math.max(0, now - start);
}

/** "12 s", "4 min 5 s": a ticking duration in whole seconds. */
export function formatElapsed(ms: number): string {
  const { t } = currentI18n();
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return t("format.duration.seconds", { seconds: total });
  const minutes = Math.floor(total / 60);
  return t("format.duration.minutesSeconds", { minutes, seconds: total - minutes * 60 });
}

/** Per-run activity for the runs of one screen, fed by SSE `run_event` frames and fetched tails. */
export type RunActivityMap = Readonly<Record<string, RunActivityState>>;

export type RunActivityAction =
  | { type: "reset" }
  /** Live frames; a tail fetched for a run is applied the same way, one event at a time. */
  | { type: "events"; runId: RunId; events: readonly RunEvent[] }
  | { type: "forget"; runId: RunId };

export function runActivityReducer(
  state: RunActivityMap,
  action: RunActivityAction,
): RunActivityMap {
  switch (action.type) {
    case "reset":
      return {};
    case "events": {
      const current = state[action.runId] ?? EMPTY_RUN_ACTIVITY;
      const next = runActivityOf(action.events, current);
      return next === current ? state : { ...state, [action.runId]: next };
    }
    case "forget": {
      if (!(action.runId in state)) return state;
      const next = { ...state };
      delete next[action.runId];
      return next;
    }
  }
}
