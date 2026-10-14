// T0: the run reducer keeps events in seq order, dedupes redeliveries, merges SSE events that
// arrived before the initial fetch, and ignores frames for other runs.

import type { RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { RUN_ID, THREAD_ID, message, run, runEvent, usage } from "../test-support/fixtures.js";
import { initialRunView, runViewReducer } from "./run-view.js";

describe("runViewReducer", () => {
  it("loads run, usage and events and keeps events already received over SSE", () => {
    let s = initialRunView(RUN_ID);
    s = runViewReducer(s, {
      type: "run_event",
      threadId: THREAD_ID,
      event: runEvent(3, "log", { late: true }),
    });
    s = runViewReducer(s, {
      type: "loaded",
      run: run({ status: "running" }),
      usage: [usage("m", null)],
      events: [runEvent(2, "tool_call", {}), runEvent(1, "thinking", {})],
    });
    expect(s.run?.status).toBe("running");
    expect(s.usage).toHaveLength(1);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps a terminal status a stale load would roll back", () => {
    // The run finished over SSE while `getRun` was in flight; the response describes it running.
    let s = runViewReducer(initialRunView(RUN_ID), {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "succeeded", finishedAt: "2026-09-21T10:00:05.000Z" }),
    });
    s = runViewReducer(s, {
      type: "loaded",
      run: run({ status: "running" }),
      usage: [],
      events: [runEvent(1, "log", {})],
    });
    expect(s.run?.status).toBe("succeeded");
    expect(s.events.map((e) => e.seq)).toEqual([1]);

    // A non-terminal status still moves forward.
    s = runViewReducer(initialRunView(RUN_ID), {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "queued" }),
    });
    s = runViewReducer(s, {
      type: "loaded",
      run: run({ status: "running" }),
      usage: [],
      events: [],
    });
    expect(s.run?.status).toBe("running");
  });

  it("keeps current usage while merging events from an older attempt snapshot", () => {
    const currentUsage = [usage("current-model", 0.03)];
    let state = runViewReducer(initialRunView(RUN_ID), {
      type: "loaded",
      run: run({ status: "running", attempt: 2 }),
      usage: currentUsage,
      events: [runEvent(2, "log", { text: "current attempt" })],
    });
    state = runViewReducer(state, {
      type: "loaded",
      run: run({ status: "waiting_continuation", attempt: 1 }),
      usage: [usage("older-model", 0.01)],
      events: [runEvent(1, "log", { text: "previous attempt" })],
    });
    expect(state.run?.attempt).toBe(2);
    expect(state.run?.status).toBe("running");
    expect(state.usage).toEqual(currentUsage);
    expect(state.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("inserts run_event frames by seq and drops duplicate seqs", () => {
    let s = initialRunView(RUN_ID);
    for (const seq of [2, 1, 2, 4, 3]) {
      s = runViewReducer(s, {
        type: "run_event",
        threadId: THREAD_ID,
        event: runEvent(seq, "log", { seq }),
      });
    }
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("replaces the run on run_status and ignores other runs and thread messages", () => {
    let s = runViewReducer(initialRunView(RUN_ID), {
      type: "loaded",
      run: run(),
      usage: [],
      events: [],
    });
    s = runViewReducer(s, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "succeeded", finishedAt: "2026-09-21T10:00:05.000Z" }),
    });
    expect(s.run?.status).toBe("succeeded");

    const other = "run_other" as RunId;
    const before = s;
    s = runViewReducer(s, { type: "run_status", threadId: THREAD_ID, run: run({ id: other }) });
    s = runViewReducer(s, {
      type: "run_event",
      threadId: THREAD_ID,
      event: { ...runEvent(1, "log", {}), runId: other },
    });
    s = runViewReducer(s, {
      type: "thread_message",
      threadId: THREAD_ID,
      message: message(1, "human", "x"),
    });
    s = runViewReducer(s, { type: "loaded", run: run({ id: other }), usage: [], events: [] });
    expect(s).toBe(before);
  });
});
