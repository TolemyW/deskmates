import { describe, expect, it } from "vitest";
import {
  type RunTimelineEvent,
  type RunTimelineMark,
  buildRunTimeline,
  timelineMark,
  timelineStage,
} from "./run-timeline.js";

const T0 = Date.parse("2026-10-14T10:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0 + offsetMs);
const iso = (offsetMs: number): string => at(offsetMs).toISOString();

function mark(
  name: RunTimelineMark,
  offsetMs: number,
  attrs: Record<string, unknown> = {},
  attempt = 1,
): RunTimelineEvent {
  return {
    kind: "log",
    attempt,
    payload: timelineMark(name, at(offsetMs), attrs),
    ts: iso(offsetMs),
  };
}

function timing(
  phase: string,
  edge: "start" | "end",
  offsetMs: number,
  extra: Record<string, unknown> = {},
  attempt = 1,
): RunTimelineEvent {
  return {
    kind: "log",
    attempt,
    payload: {
      source: "phase_timing",
      version: 1,
      spanId: "s",
      phase,
      edge,
      at: iso(offsetMs),
      ...extra,
    },
    ts: iso(offsetMs),
  };
}

/** A normal warm start: every mark observed, 4 s to the reply. */
function happyEvents(): RunTimelineEvent[] {
  return [
    mark("attempt_started", 100, { start: "fresh", session: "new" }),
    mark("sandbox_ready", 150, { sandbox: "cached" }),
    mark("sidecar_spawned", 160),
    mark("sidecar_started", 900, { processStartedAt: iso(200) }),
    mark("query_started", 1000),
    mark("sdk_init", 1500, { mcpServers: [{ name: "deskmates", status: "connected" }] }),
    timing("model_request", "start", 1600),
    timing("model_first_byte", "end", 2600, { outcome: "ok" }),
    mark("first_stream_event", 2650),
    mark("first_token", 2700),
    mark("first_text", 3000),
    mark("sdk_result", 3900, { numTurns: 1, durationApiMs: 2200, ttftMs: 1050 }),
    mark("run_ended", 4000, { outcome: "completed", replyPosted: true }),
    mark("attempt_closed", 4100, { spawned: true, exitCode: 0 }),
    {
      kind: "turn_usage",
      attempt: 1,
      payload: {
        turn: 1,
        model: "m",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 9000,
        cacheCreateTokens: null,
      },
      ts: iso(3000),
    },
  ];
}

const base = {
  runId: "run_1",
  status: "succeeded",
  attempt: 1,
  createdAt: iso(20),
  submittedAt: iso(0),
  finishedAt: iso(4000),
};

describe("buildRunTimeline", () => {
  it("lists every stage of a complete start with durations from submission", () => {
    const timeline = buildRunTimeline({ ...base, events: happyEvents() });
    expect(timeline.e2eMs).toBe(4000);
    const [attempt] = timeline.attempts;
    expect(attempt).toBeDefined();
    if (!attempt) return;
    expect(attempt.stages.every((s) => s.observed)).toBe(true);
    expect(timelineStage(attempt, "routed")?.sinceStartMs).toBe(20);
    expect(timelineStage(attempt, "sidecar_started")?.at).toBe(iso(200));
    expect(timelineStage(attempt, "first_upstream_request")?.sinceStartMs).toBe(1600);
    expect(timelineStage(attempt, "first_token")?.sinceStartMs).toBe(2700);
    expect(timelineStage(attempt, "first_visible_text")?.sinceStartMs).toBe(4000);
    expect(attempt.start).toBe("fresh");
    expect(attempt.session).toBe("new");
    expect(attempt.sandbox).toBe("cached");
    expect(attempt.closed).toBe(true);
    expect(attempt.waitingFor).toBeNull();
    expect(attempt.slowestStage).toBe("first_upstream_byte");
    expect(attempt.sdkReported).toEqual({ numTurns: 1, durationApiMs: 2200, ttftMs: 1050 });
    expect(attempt.firstTurnUsage).toEqual({
      inputTokens: 10,
      cacheReadTokens: 9000,
      cacheCreateTokens: null,
    });
    expect(attempt.mcpServers).toEqual([{ name: "deskmates", status: "connected" }]);
  });

  it("names a slow container start as the slowest stage", () => {
    const events = happyEvents().map((e) =>
      e.payload.mark === "sandbox_ready"
        ? mark("sandbox_ready", 30_000, { sandbox: "created" })
        : e,
    );
    const [attempt] = buildRunTimeline({ ...base, events }).attempts;
    expect(attempt?.sandbox).toBe("created");
    expect(attempt?.slowestStage).toBe("sandbox_ready");
  });

  it("names a slow first token without guessing the missing byte", () => {
    const events = happyEvents()
      .filter((e) => e.payload.phase !== "model_first_byte")
      .map((e) => (e.payload.mark === "first_token" ? mark("first_token", 2900) : e));
    const slow = events.map((e) =>
      e.payload.mark === "first_stream_event" ? mark("first_stream_event", 2850) : e,
    );
    const [attempt] = buildRunTimeline({ ...base, events: slow }).attempts;
    if (!attempt) throw new Error("no attempt");
    const byte = timelineStage(attempt, "first_upstream_byte");
    expect(byte).toMatchObject({ observed: false, at: null, missing: "not_observed" });
    expect(byte?.sinceStartMs).toBeNull();
    expect(attempt.slowestStage).toBe("first_stream_event");
    expect(timelineStage(attempt, "first_stream_event")?.gapMs).toBe(1250);
  });

  it("counts SDK retries in the attempt they happened in", () => {
    const events = [
      ...happyEvents(),
      { kind: "model_retry", attempt: 1, payload: { attempt: 1 }, ts: iso(2000) },
      { kind: "model_retry", attempt: 1, payload: { attempt: 2 }, ts: iso(2200) },
    ];
    const [attempt] = buildRunTimeline({ ...base, events }).attempts;
    expect(attempt?.modelRetries).toBe(2);
  });

  it("ignores token-count requests and repeated marks", () => {
    const events = [
      timing("model_request", "start", 1200, { requestKind: "count_tokens" }),
      ...happyEvents(),
      mark("first_token", 5000),
    ];
    const [attempt] = buildRunTimeline({ ...base, events }).attempts;
    if (!attempt) throw new Error("no attempt");
    expect(timelineStage(attempt, "first_upstream_request")?.sinceStartMs).toBe(1600);
    expect(timelineStage(attempt, "first_token")?.sinceStartMs).toBe(2700);
  });

  it("measures a resumed attempt from when it became runnable", () => {
    const events = [
      ...happyEvents().filter((e) => e.payload.mark !== "run_ended"),
      mark("run_ended", 4000, { outcome: "deferred", replyPosted: false }),
      mark(
        "attempt_started",
        60_100,
        { start: "resume", session: "resumed", readyAt: iso(60_000) },
        2,
      ),
      mark("sandbox_ready", 60_120, { sandbox: "cached" }, 2),
      mark("sidecar_spawned", 60_130, {}, 2),
      mark("first_token", 62_000, {}, 2),
      mark("run_ended", 63_000, { outcome: "completed", replyPosted: true }, 2),
      mark("attempt_closed", 63_100, { spawned: true, exitCode: 0 }, 2),
    ];
    const timeline = buildRunTimeline({ ...base, attempt: 2, finishedAt: iso(63_000), events });
    expect(timeline.attempts).toHaveLength(2);
    const [first, second] = timeline.attempts;
    expect(first?.outcome).toBe("deferred");
    expect(timelineStage(first ?? (undefined as never), "first_visible_text")?.observed).toBe(
      false,
    );
    expect(second?.start).toBe("resume");
    expect(second?.session).toBe("resumed");
    if (!second) return;
    expect(timelineStage(second, "submitted")?.at).toBe(iso(60_000));
    expect(timelineStage(second, "routed")?.missing).toBe("not_applicable");
    expect(timelineStage(second, "first_token")?.sinceStartMs).toBe(2000);
    expect(timelineStage(second, "sdk_init")?.missing).toBe("not_observed");
  });

  it("shows a cancelled attempt as closed with what it reached", () => {
    const events = [
      mark("attempt_started", 100, { start: "fresh", session: "new" }),
      mark("sandbox_ready", 150, { sandbox: "attached" }),
      mark("sidecar_spawned", 160),
      mark("sidecar_started", 900),
      mark("attempt_closed", 5000, { spawned: true, exitCode: 137, error: "cancelled" }),
    ];
    const [attempt] = buildRunTimeline({
      ...base,
      status: "cancelled",
      finishedAt: iso(4000),
      events,
    }).attempts;
    expect(attempt?.closed).toBe(true);
    expect(attempt?.outcome).toBe("cancelled");
    expect(attempt?.waitingFor).toBeNull();
    expect(attempt?.sandbox).toBe("attached");
    expect(attempt?.stages.filter((s) => !s.observed).map((s) => s.stage)).toEqual([
      "query_started",
      "sdk_init",
      "first_upstream_request",
      "first_upstream_byte",
      "first_stream_event",
      "first_token",
      "first_text",
      "first_visible_text",
      "run_ended",
    ]);
  });

  it("says where an open attempt is waiting after the sidecar went quiet", () => {
    const events = [
      mark("attempt_started", 100, { start: "fresh", session: "resumed" }),
      mark("sandbox_ready", 150, { sandbox: "cached" }),
      mark("sidecar_spawned", 160),
      mark("sidecar_started", 900),
      mark("query_started", 1000),
      mark("sdk_init", 1500),
      timing("model_request", "start", 1600),
    ];
    const [attempt] = buildRunTimeline({
      ...base,
      status: "running",
      finishedAt: null,
      events,
    }).attempts;
    expect(attempt?.closed).toBe(false);
    expect(attempt?.waitingFor).toBe("first_upstream_byte");
  });

  it("reports a queued run as waiting to start, with nothing invented", () => {
    const timeline = buildRunTimeline({
      ...base,
      status: "queued",
      attempt: 0,
      finishedAt: null,
      events: [],
    });
    expect(timeline.e2eMs).toBeNull();
    const [attempt] = timeline.attempts;
    expect(attempt?.waitingFor).toBe("attempt_started");
    expect(attempt?.session).toBe("unknown");
    expect(attempt?.sandbox).toBe("unknown");
    expect(attempt?.stages.filter((s) => s.observed).map((s) => s.stage)).toEqual([
      "submitted",
      "routed",
    ]);
  });

  it("takes the first visible text from a thread post or a preview before the reply", () => {
    const events = [
      ...happyEvents(),
      {
        kind: "log",
        attempt: 1,
        payload: { tool: "thread_post", messageId: "msg_1" },
        ts: iso(3500),
      },
      mark("reply_preview_published", 3200),
    ];
    const [attempt] = buildRunTimeline({ ...base, events }).attempts;
    if (!attempt) throw new Error("no attempt");
    expect(timelineStage(attempt, "first_visible_text")?.sinceStartMs).toBe(3200);
  });
});
