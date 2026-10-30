import { describe, expect, it } from "vitest";
import {
  type CompactBoundaryPayload,
  type ModelRetryPayload,
  type ModelSwitchPayload,
  PARKED_RUN_STATUSES,
  PLATFORM_RESUME_LIMIT,
  RUN_ERROR_CRON_MISFIRE,
  RUN_ERROR_GATEWAY_RESTARTED,
  RUN_EVENT_KINDS,
  RUN_TRIGGER_KINDS,
  type RunEventKind,
  type RunStatus,
  type TurnUsagePayload,
  canTransition,
  deriveRunVisibility,
  isExecuting,
  isRunTriggerKind,
  isSilentOutcome,
  isTerminal,
  occupiesLane,
} from "./run.js";

const ALL: RunStatus[] = [
  "queued",
  "running",
  "stalled",
  "waiting_approval_live",
  "waiting_approval",
  "waiting_browser",
  "waiting_continuation",
  "waiting_platform",
  "succeeded",
  "silent",
  "failed",
  "cancelled",
  "stopped",
];

describe("run state machine (design v0.3 §4)", () => {
  it("follows the documented happy path", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("running", "silent")).toBe(true);
  });

  it("follows the approval path: running → live → deferred → running", () => {
    expect(canTransition("running", "waiting_approval_live")).toBe(true);
    expect(canTransition("waiting_approval_live", "waiting_approval")).toBe(true);
    expect(canTransition("waiting_approval_live", "running")).toBe(true);
    expect(canTransition("waiting_approval", "running")).toBe(true);
  });

  it("follows the browser path: running → waiting_browser → running", () => {
    expect(canTransition("running", "waiting_browser")).toBe(true);
    expect(canTransition("waiting_browser", "running")).toBe(true);
  });
  it("parks turn exhaustion for continuation or stop", () => {
    expect(canTransition("running", "waiting_continuation")).toBe(true);
    expect(canTransition("waiting_continuation", "running")).toBe(true);
    expect(canTransition("waiting_continuation", "stopped")).toBe(true);
    expect(isTerminal("stopped")).toBe(true);
    expect(occupiesLane("waiting_continuation")).toBe(false);
  });

  it("marks a quiet run stalled and lets it come back or end like a running one (issue #9)", () => {
    expect(canTransition("running", "stalled")).toBe(true);
    expect(canTransition("stalled", "running")).toBe(true);
    for (const to of ALL.filter((s) => s !== "stalled" && s !== "running"))
      expect(canTransition("stalled", to)).toBe(canTransition("running", to));
    expect(canTransition("queued", "stalled")).toBe(false);
    expect(canTransition("waiting_approval_live", "stalled")).toBe(false);
    expect(isTerminal("stalled")).toBe(false);
    expect(occupiesLane("stalled")).toBe(true);
    expect(isExecuting("stalled")).toBe(true);
    expect(isExecuting("waiting_approval")).toBe(false);
  });

  it("parks a platform-interrupted run and continues it (ADR-0029 decisions 2 and 4)", () => {
    for (const from of ["running", "stalled", "waiting_approval_live"] as const) {
      expect(canTransition(from, "waiting_platform")).toBe(true);
      // A restart requeues a live run that never reached the SDK as a new attempt.
      expect(canTransition(from, "queued")).toBe(true);
    }
    expect(canTransition("waiting_platform", "running")).toBe(true);
    // A drained live approval wait waits on its approval once the drain is over.
    expect(canTransition("waiting_platform", "waiting_approval")).toBe(true);
    expect(canTransition("waiting_platform", "failed")).toBe(true);
    expect(canTransition("waiting_platform", "cancelled")).toBe(true);
    expect(canTransition("waiting_platform", "succeeded")).toBe(false);
    expect(canTransition("queued", "waiting_platform")).toBe(false);
    expect(PARKED_RUN_STATUSES.has("waiting_platform")).toBe(true);
    expect(isTerminal("waiting_platform")).toBe(false);
    expect(occupiesLane("waiting_platform")).toBe(false);
    expect(isExecuting("waiting_platform")).toBe(false);
    expect(PLATFORM_RESUME_LIMIT).toBe(3);
  });

  it("names the platform's own run errors as stable codes (ADR-0029 decisions 7 and 11)", () => {
    expect(RUN_ERROR_GATEWAY_RESTARTED).toBe("gateway_restarted");
    expect(RUN_ERROR_CRON_MISFIRE).toBe("cron_misfire");
  });

  it("never leaves a terminal state", () => {
    for (const from of ALL.filter(isTerminal)) {
      for (const to of ALL) expect(canTransition(from, to)).toBe(false);
    }
  });

  it("lets a queued run fail when it cannot start, so its lane is freed", () => {
    expect(canTransition("queued", "failed")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
  });

  it("does not skip running", () => {
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("queued", "waiting_approval")).toBe(false);
    expect(canTransition("waiting_approval", "succeeded")).toBe(false);
  });

  it("parked runs do not occupy the lane; live waits do", () => {
    expect(occupiesLane("running")).toBe(true);
    expect(occupiesLane("waiting_approval_live")).toBe(true);
    expect(occupiesLane("waiting_approval")).toBe(false);
    expect(occupiesLane("waiting_browser")).toBe(false);
    expect(occupiesLane("succeeded")).toBe(false);
  });
});

describe("run event kinds (M3 context plan, Phase 1)", () => {
  it("lists every RunEventKind exactly once, including the context observability kinds", () => {
    expect(new Set(RUN_EVENT_KINDS).size).toBe(RUN_EVENT_KINDS.length);
    expect(RUN_EVENT_KINDS).toContain("turn_usage");
    expect(RUN_EVENT_KINDS).toContain("compact_boundary");
    const all: readonly RunEventKind[] = [
      "tool_call",
      "tool_result",
      "thinking",
      "screenshot",
      "log",
      "approval",
      "takeover",
      "cap_breached",
      "pricing_missing",
      "turn_usage",
      "compact_boundary",
      "rule_file_modified",
      "memory_index",
      "memory_skipped",
      "cost_alert",
      "model_switch",
      "model_retry",
      "skill_used",
    ];
    expect([...RUN_EVENT_KINDS].sort()).toEqual([...all].sort());
  });

  it("types the turn_usage and compact_boundary payloads", () => {
    const usage: TurnUsagePayload = {
      model: "m",
      turn: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreateTokens: 0,
    };
    const boundary: CompactBoundaryPayload = { trigger: "auto", preTokens: 150_000 };
    expect(usage.turn).toBe(1);
    expect(boundary.postTokens).toBeUndefined();
  });
});

describe("model switch and retry events (ADR-0023 decision 3)", () => {
  it("are ledger kinds with typed payloads", () => {
    expect(RUN_EVENT_KINDS).toContain("model_switch");
    expect(RUN_EVENT_KINDS).toContain("model_retry");
    const switched: ModelSwitchPayload = { from: "primary", to: "fallback", source: "auto" };
    const retried: ModelRetryPayload = {
      attempt: 1,
      maxRetries: 10,
      retryDelayMs: 500,
      errorStatus: 529,
      error: "overloaded",
    };
    expect(switched.source).toBe("auto");
    expect(retried.errorStatus).toBe(529);
  });
});

describe("run visibility (issue #70)", () => {
  const post = (tool: string) => ({
    kind: "log" as const,
    payload: { tool, threadId: "thr_1", messageId: "msg_1" },
  });
  const ended = { status: "succeeded" as const, threadId: "thr_1" };

  it("is all false for a run that replied nothing and left no Gateway-written trace", () => {
    expect(deriveRunVisibility({ ...ended, status: "failed", reply: "", events: [] })).toEqual({
      finalReply: false,
      postedToThread: false,
      decidedApproval: false,
      deliveredTask: false,
      visibleOutcome: false,
      silent: false,
    });
    expect(deriveRunVisibility({ ...ended, events: [] }).visibleOutcome).toBe(false);
    expect(deriveRunVisibility({ ...ended, reply: "  \n", events: [] }).finalReply).toBe(false);
  });

  it("counts a non-empty final reply", () => {
    const v = deriveRunVisibility({ ...ended, reply: "done", events: [] });
    expect(v.finalReply).toBe(true);
    expect(v.visibleOutcome).toBe(true);
  });

  it("counts thread_post and message_bot posts the Gateway recorded", () => {
    for (const tool of ["thread_post", "message_bot"]) {
      const v = deriveRunVisibility({ ...ended, reply: "", events: [post(tool)] });
      expect(v).toMatchObject({ postedToThread: true, finalReply: false, visibleOutcome: true });
    }
  });

  it("counts an approval decided through approval_decide", () => {
    const v = deriveRunVisibility({
      ...ended,
      reply: "",
      events: [
        {
          kind: "approval",
          payload: { phase: "decided_by_tool", approvalId: "apr_1", decision: "allow_once" },
        },
      ],
    });
    expect(v).toMatchObject({ decidedApproval: true, visibleOutcome: true });
  });

  it("counts a task delivered through task_deliver", () => {
    const v = deriveRunVisibility({
      ...ended,
      reply: "",
      events: [{ kind: "log", payload: { tool: "task_deliver", taskId: "task_1", summary: "x" } }],
    });
    expect(v).toMatchObject({ deliveredTask: true, visibleOutcome: true });
  });

  it("ignores look-alikes that are not the Gateway's own record", () => {
    const v = deriveRunVisibility({
      ...ended,
      reply: "",
      events: [
        // A tool call the model made is not proof the Gateway accepted it.
        { kind: "tool_call", payload: { tool: "thread_post", messageId: "msg_1" } },
        // The Gateway's records carry the id of what they wrote.
        { kind: "log", payload: { tool: "thread_post" } },
        { kind: "log", payload: { tool: "task_deliver" } },
        { kind: "approval", payload: { phase: "decided", approvalId: "apr_1" } },
        { kind: "approval", payload: { phase: "decided_by_tool" } },
        { kind: "log", payload: { source: "final_reply", op: "deduplicated", messageId: "m" } },
      ],
    });
    expect(v.visibleOutcome).toBe(false);
  });
});

describe("silent (owner definition, 2026-10-17)", () => {
  const post = { kind: "log", payload: { tool: "thread_post", messageId: "msg_1" } };

  it("is a thread run that ended successfully without posting a message", () => {
    for (const status of ["succeeded", "silent"] as const)
      expect(deriveRunVisibility({ status, threadId: "thr_1", reply: "", events: [] }).silent).toBe(
        true,
      );
  });

  it("is never a failed, cancelled or stopped run, whatever it posted", () => {
    for (const status of ["failed", "cancelled", "stopped"] as const) {
      expect(deriveRunVisibility({ status, threadId: "thr_1", reply: "", events: [] }).silent).toBe(
        false,
      );
    }
  });

  it("is not a run that posted through thread_post or replied, even one stored silent", () => {
    const v = deriveRunVisibility({
      status: "silent",
      threadId: "thr_1",
      reply: "",
      events: [post],
    });
    expect(v.silent).toBe(false);
    expect(
      deriveRunVisibility({ status: "succeeded", threadId: "thr_1", reply: "ok", events: [] })
        .silent,
    ).toBe(false);
  });

  it("is not a run without a thread, nor a run still going", () => {
    expect(deriveRunVisibility({ status: "succeeded", reply: "", events: [] }).silent).toBe(false);
    expect(
      isSilentOutcome({
        status: "running",
        threadId: "t",
        finalReply: false,
        postedToThread: false,
      }),
    ).toBe(false);
  });
});

describe("run trigger kinds (issue #39 item 7)", () => {
  it("names model jobs apart from cron", () => {
    expect(RUN_TRIGGER_KINDS).toContain("model_job");
    expect(RUN_TRIGGER_KINDS).toContain("cron");
    expect(new Set(RUN_TRIGGER_KINDS).size).toBe(RUN_TRIGGER_KINDS.length);
    expect(isRunTriggerKind("model_job")).toBe(true);
    expect(isRunTriggerKind("job")).toBe(false);
    expect(isRunTriggerKind(undefined)).toBe(false);
  });
});
