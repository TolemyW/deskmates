// T0: the thread reducer keeps the transcript in seq order, dedupes SSE echoes of messages the
// composer already added, tracks runs by id, merges a fetch into what the stream already
// delivered rather than replacing it, and ignores ledger events.

import { describe, expect, it } from "vitest";
import {
  APPROVAL_ID,
  RUN_ID,
  THREAD_ID,
  approval,
  message,
  run,
  runEvent,
} from "../test-support/fixtures.js";
import {
  EMPTY_THREAD_VIEW,
  activeRuns,
  latestRunForBot,
  threadViewReducer,
  transcriptTimeline,
  unsuccessfulRuns,
} from "./thread-view.js";

describe("threadViewReducer", () => {
  it("loads messages sorted by seq and indexes runs by id", () => {
    const s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "loaded",
      messages: [message(2, "bot", "b"), message(1, "human", "a")],
      runs: [run({ id: "run_a" as never }), run({ id: "run_b" as never, status: "succeeded" })],
    });
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(Object.keys(s.runs)).toEqual(["run_a", "run_b"]);
  });

  it("appends thread_message frames in seq order and drops duplicates", () => {
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "loaded",
      messages: [message(1, "human", "a")],
      runs: [],
    });
    s = threadViewReducer(s, {
      type: "thread_message",
      threadId: THREAD_ID,
      message: message(3, "bot", "c"),
    });
    s = threadViewReducer(s, {
      type: "thread_message",
      threadId: THREAD_ID,
      message: message(2, "system", "b"),
    });
    s = threadViewReducer(s, {
      type: "thread_message",
      threadId: THREAD_ID,
      message: message(3, "bot", "c again"),
    });
    expect(s.messages.map((m) => `${m.seq}:${m.body}`)).toEqual(["1:a", "2:b", "3:c"]);
  });

  it("upserts runs on run_status and reports non-terminal ones as active", () => {
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "queued" }),
    });
    expect(activeRuns(s).map((r) => r.status)).toEqual(["queued"]);
    s = threadViewReducer(s, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "running" }),
    });
    expect(activeRuns(s).map((r) => r.status)).toEqual(["running"]);
    s = threadViewReducer(s, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "succeeded" }),
    });
    expect(activeRuns(s)).toEqual([]);
    expect(Object.keys(s.runs)).toHaveLength(1);
  });

  it("retains unsuccessful runs and reports the latest bot state", () => {
    const failed = run({ id: "run_failed" as never, status: "failed", error: "model offline" });
    const cancelled = run({
      id: "run_cancelled" as never,
      status: "cancelled",
      createdAt: "2026-09-21T10:01:00.000Z",
    });
    const s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "loaded",
      messages: [],
      runs: [failed, cancelled],
    });

    expect(unsuccessfulRuns(s).map((candidate) => candidate.id)).toEqual([failed.id, cancelled.id]);
    expect(latestRunForBot(s, failed.botId)?.status).toBe("cancelled");
  });

  it("places a failed run in the transcript where it happened, not after everything", () => {
    // Testbox, 2026-09-29: a run that failed at 15:39 kept showing below the 16:00 answers, so
    // an old, fixed failure looked like the newest event in the thread.
    const at = (hhmm: string) => `2026-09-29T${hhmm}:00.000Z`;
    const failed = run({
      id: "run_old_failure" as never,
      status: "failed",
      error: "container not healthy",
      createdAt: at("07:39"),
      finishedAt: at("07:40") as never,
    });
    const later = run({ id: "run_later" as never, status: "cancelled", createdAt: at("08:05") });
    const s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "loaded",
      messages: [
        message(1, "human", "@chief 测试进度怎么样", { ts: at("07:38") as never }),
        message(2, "human", "@chief retry", { ts: at("08:00") as never }),
        message(3, "bot", "测试已全部收口", { ts: at("08:01") as never }),
      ],
      runs: [later, failed],
    });
    expect(
      transcriptTimeline(s).map((item) =>
        item.kind === "message" ? `msg${item.message.seq}` : item.run.id,
      ),
    ).toEqual(["msg1", "run_old_failure", "msg2", "msg3", "run_later"]);
  });

  it("keeps an earlier failure visible after the same bot later succeeds", () => {
    const at = (hhmm: string) => `2026-09-29T${hhmm}:00.000Z`;
    const failed = run({
      id: "run_failed" as never,
      status: "failed",
      createdAt: at("07:39"),
    });
    const otherBotFailed = run({
      id: "run_other" as never,
      botId: "bot_other" as never,
      status: "failed",
      createdAt: at("07:50"),
    });
    const retried = run({ id: "run_retry" as never, status: "succeeded", createdAt: at("08:00") });
    const s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "loaded",
      messages: [],
      runs: [failed, otherBotFailed, retried],
    });
    const outcomes = transcriptTimeline(s).flatMap((item) =>
      item.kind === "outcome" ? [item.run.id] : [],
    );
    expect(outcomes).toEqual(["run_failed", "run_other"]);
  });

  it("merges a stale load into what SSE already delivered instead of replacing it", () => {
    // The fetch behind `loaded` left before the bot answered, so it describes the thread as it was.
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "thread_message",
      threadId: THREAD_ID,
      message: message(2, "bot", "done, all green", { runId: "run_a" as never }),
    });
    s = threadViewReducer(s, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ id: "run_a" as never, status: "succeeded" }),
    });
    s = threadViewReducer(s, {
      type: "loaded",
      messages: [message(1, "human", "check the console")],
      runs: [run({ id: "run_a" as never, status: "running" })],
    });

    // The reply survives, in seq order with the fetched history.
    expect(s.messages.map((m) => `${m.seq}:${m.body}`)).toEqual([
      "1:check the console",
      "2:done, all green",
    ]);
    // And the run stays finished, so the typing indicator does not stick.
    expect(s.runs.run_a?.status).toBe("succeeded");
    expect(activeRuns(s)).toEqual([]);
  });

  it("lets a load advance a run that has not finished, and resets only on reset", () => {
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "queued" }),
    });
    s = threadViewReducer(s, {
      type: "loaded",
      messages: [],
      runs: [run({ status: "running" })],
      runSnapshotRevision: s.runRevision,
    });
    expect(activeRuns(s).map((r) => r.status)).toEqual(["running"]);

    s = threadViewReducer(s, { type: "reset" });
    expect(s).toEqual(EMPTY_THREAD_VIEW);
  });

  it("rejects stale HTTP non-terminal states without blocking later live cycles or snapshots", () => {
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "loaded",
      messages: [],
      runs: [run({ status: "queued" })],
      runSnapshotRevision: 0,
    });
    const beforeFirstFetch = s.runRevision;

    // This live update arrived after the fetch began. Its legal non-terminal state must survive
    // even when the older HTTP response returns another non-terminal state.
    s = threadViewReducer(s, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "waiting_approval_live" }),
    });
    s = threadViewReducer(s, {
      type: "loaded",
      messages: [],
      runs: [run({ status: "running" })],
      runSnapshotRevision: beforeFirstFetch,
    });
    expect(s.runs[RUN_ID]?.status).toBe("waiting_approval_live");

    // Live updates are never state-ranked: both directions of the approval cycle still apply.
    s = threadViewReducer(s, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "running" }),
    });
    const beforeSecondFetch = s.runRevision;
    s = threadViewReducer(s, {
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "waiting_approval" }),
    });
    s = threadViewReducer(s, {
      type: "loaded",
      messages: [],
      runs: [run({ status: "running" })],
      runSnapshotRevision: beforeSecondFetch,
    });
    expect(s.runs[RUN_ID]?.status).toBe("waiting_approval");

    // A snapshot started after the last live update remains authoritative for gap recovery.
    s = threadViewReducer(s, {
      type: "loaded",
      messages: [],
      runs: [run({ status: "running" })],
      runSnapshotRevision: s.runRevision,
    });
    expect(s.runs[RUN_ID]?.status).toBe("running");
  });

  it("indexes approvals from a load and upserts them from the approval frame", () => {
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "loaded",
      messages: [],
      runs: [],
      approvals: [approval()],
    });
    expect(s.approvals[APPROVAL_ID]?.decision).toBeUndefined();

    const decided = approval({
      decision: "allow_once",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    s = threadViewReducer(s, { type: "approval", threadId: THREAD_ID, approval: decided });
    expect(s.approvals[APPROVAL_ID]?.decision).toBe("allow_once");
  });

  it("never regresses a decided approval back to pending", () => {
    const decided = approval({
      decision: "deny",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "approval",
      threadId: THREAD_ID,
      approval: decided,
    });
    // A list fetch that left before the decision, and a duplicate request frame, are both stale.
    s = threadViewReducer(s, { type: "loaded", messages: [], runs: [], approvals: [approval()] });
    s = threadViewReducer(s, { type: "approval", threadId: THREAD_ID, approval: approval() });
    expect(s.approvals[APPROVAL_ID]?.decision).toBe("deny");

    // A later decision on the same approval does win.
    const later = approval({
      decision: "allow_once",
      decidedBy: "bot:bot_1",
      decidedAt: "2026-09-21T10:02:00.000Z",
    });
    s = threadViewReducer(s, { type: "approval", threadId: THREAD_ID, approval: later });
    expect(s.approvals[APPROVAL_ID]?.decidedBy).toBe("bot:bot_1");
  });

  it("keeps approvals across a load with none and clears them on reset", () => {
    let s = threadViewReducer(EMPTY_THREAD_VIEW, {
      type: "approval",
      threadId: THREAD_ID,
      approval: approval(),
    });
    s = threadViewReducer(s, { type: "loaded", messages: [], runs: [] });
    expect(Object.keys(s.approvals)).toEqual([APPROVAL_ID]);
    s = threadViewReducer(s, { type: "reset" });
    expect(s).toEqual(EMPTY_THREAD_VIEW);
  });

  it("leaves state untouched on run_event", () => {
    const s0 = threadViewReducer(EMPTY_THREAD_VIEW, { type: "loaded", messages: [], runs: [] });
    const s1 = threadViewReducer(s0, {
      type: "run_event",
      threadId: THREAD_ID,
      event: runEvent(1, "thinking", { text: "..." }),
    });
    expect(s1).toBe(s0);
  });
});
