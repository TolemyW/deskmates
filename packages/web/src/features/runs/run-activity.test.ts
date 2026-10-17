import type { RunEvent, RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_RUN_ACTIVITY,
  currentActivity,
  elapsedMs,
  formatElapsed,
  runActivityOf,
  runActivityReducer,
} from "./run-activity.js";

const RUN = "run_1" as RunId;
let seq = 0;
function ev(kind: RunEvent["kind"], payload: Record<string, unknown>, ts: string): RunEvent {
  seq += 1;
  return { runId: RUN, seq, kind, payload, ts };
}
const call = (id: string, toolName: string, ts: string) =>
  ev("tool_call", { toolUseId: id, toolName, input: {} }, ts);
const result = (id: string, ts: string) => ev("tool_result", { toolUseId: id, isError: false }, ts);
const span = (
  phase: string,
  edge: "start" | "end",
  spanId: string,
  at: string,
  extra: Record<string, unknown> = {},
) => ev("log", { source: "phase_timing", version: 1, phase, edge, spanId, at, ...extra }, at);
/** The three spans the Gateway's model proxy opens for one request. */
const requestStart = (id: string, at: string, requestKind = "messages") => [
  span("model_request", "start", id, at, { requestKind }),
  span("model_headers", "start", `${id}-h`, at, { parentSpanId: id, requestKind }),
  span("model_first_byte", "start", `${id}-b`, at, { parentSpanId: id, requestKind }),
];

describe("run activity (issue #9)", () => {
  it("names the open tool call, then nothing once its result arrives", () => {
    const opened = runActivityOf([call("t1", "Bash", "2026-10-15T10:00:00.000Z")]);
    expect(currentActivity(opened)).toEqual({
      kind: "tool",
      toolName: "Bash",
      since: "2026-10-15T10:00:00.000Z",
    });
    expect(currentActivity(runActivityOf([result("t1", "x")], opened))).toBeUndefined();
  });

  it("prefers the newest open tool and pairs by toolUseId, not by order", () => {
    const state = runActivityOf([
      call("a", "Read", "2026-10-15T10:00:00.000Z"),
      call("b", "Bash", "2026-10-15T10:00:05.000Z"),
      result("b", "2026-10-15T10:00:06.000Z"),
    ]);
    expect(currentActivity(state)).toMatchObject({ kind: "tool", toolName: "Read" });
  });

  it("is waiting on the model from the request's start until its first byte", () => {
    const start = requestStart("r1", "2026-10-15T10:00:10.000Z");
    expect(currentActivity(runActivityOf(start))).toEqual({
      kind: "model",
      since: "2026-10-15T10:00:10.000Z",
    });
    const firstByte = span("model_first_byte", "end", "r1-b", "2026-10-15T10:00:12.000Z", {
      parentSpanId: "r1",
      outcome: "ok",
    });
    expect(currentActivity(runActivityOf([...start, firstByte]))).toBeUndefined();
    // A request that failed before any byte is over too.
    const failed = span("model_request", "end", "r1", "2026-10-15T10:00:13.000Z", {
      outcome: "error",
    });
    expect(currentActivity(runActivityOf([...start, failed]))).toBeUndefined();
  });

  it("does not count a token-count request as waiting on the model", () => {
    expect(
      currentActivity(
        runActivityOf(requestStart("c1", "2026-10-15T10:00:00.000Z", "count_tokens")),
      ),
    ).toBeUndefined();
  });

  it("gives the same answer whatever order and however often events arrive", () => {
    const events = [
      call("t1", "Bash", "2026-10-15T10:00:00.000Z"),
      result("t1", "2026-10-15T10:00:01.000Z"),
      call("t2", "Grep", "2026-10-15T10:00:02.000Z"),
    ];
    const forward = runActivityOf(events);
    const backward = runActivityOf([...events].reverse());
    const twice = runActivityOf(events, forward);
    expect(currentActivity(backward)).toEqual(currentActivity(forward));
    expect(currentActivity(twice)).toEqual(currentActivity(forward));
    expect(currentActivity(forward)).toMatchObject({ toolName: "Grep" });
  });

  it("merges a fetched tail with live frames that arrived first", () => {
    const live = runActivityReducer(
      {},
      {
        type: "events",
        runId: RUN,
        events: [result("t1", "2026-10-15T10:00:09.000Z")],
      },
    );
    const seeded = runActivityReducer(live, {
      type: "events",
      runId: RUN,
      events: [call("t1", "Bash", "2026-10-15T10:00:00.000Z")],
    });
    expect(currentActivity(seeded[RUN])).toBeUndefined();
    expect(runActivityReducer(seeded, { type: "forget", runId: RUN })).toEqual({});
    expect(runActivityReducer(seeded, { type: "reset" })).toEqual({});
    expect(currentActivity(EMPTY_RUN_ACTIVITY)).toBeUndefined();
  });

  it("ticks whole seconds and never goes negative", () => {
    const since = "2026-10-15T10:00:00.000Z";
    expect(elapsedMs(since, Date.parse(since) + 12_400)).toBe(12_400);
    expect(elapsedMs(since, Date.parse(since) - 5_000)).toBe(0);
    expect(elapsedMs(undefined, 0)).toBe(0);
    expect(formatElapsed(12_400)).toBe("12 s");
    expect(formatElapsed(65_000)).toBe("1 min 5 s");
  });
});
