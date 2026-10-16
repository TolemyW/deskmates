// @vitest-environment jsdom
// T1 (in-process), issue #9: a running bot's row says what its run is doing now. The open tool
// call and its ticking time, or how long the model has not answered, then the run's own elapsed
// time; a stalled run says it has shown no progress. In the chat pane the row follows the run's
// `run_event` frames and is seeded from the run's newest events when the chat opens mid-run.

import type { RunEvent, RunId } from "@deskmates/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import {
  FakeEventSource,
  RUN_ID,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { type RunActivityMap, runActivityOf } from "../runs/run-activity.js";
import { ChatPane } from "./chat-pane.js";
import { ChatRunStatus } from "./chat-run-status.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const START = "2026-10-15T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();

function ev(seq: number, kind: RunEvent["kind"], payload: Record<string, unknown>, ts: string) {
  return { runId: RUN_ID, seq, kind, payload, ts } satisfies RunEvent;
}
const bash = ev(3, "tool_call", { toolUseId: "tu_1", toolName: "Bash", input: {} }, at(60));
const bashDone = ev(4, "tool_result", { toolUseId: "tu_1", isError: false }, at(95));
const modelWait = [
  ev(
    5,
    "log",
    {
      source: "phase_timing",
      phase: "model_request",
      edge: "start",
      spanId: "q1",
      at: at(100),
      requestKind: "messages",
    },
    at(100),
  ),
  ev(
    6,
    "log",
    {
      source: "phase_timing",
      phase: "model_first_byte",
      edge: "start",
      spanId: "q1b",
      parentSpanId: "q1",
      at: at(100),
      requestKind: "messages",
    },
    at(100),
  ),
];

function show(status: RunView["status"], activity: RunActivityMap) {
  render(
    <ol>
      <ChatRunStatus
        api={createApiClient({ fetch: fakeFetch({}).fetch })}
        runs={[run({ status, startedAt: START })]}
        activity={activity}
        botName={() => "ops"}
        messageBody={() => undefined}
        thread={thread}
        memberCount={1}
        onRunUpdated={() => {}}
      />
    </ol>,
  );
}

const row = () => screen.getByTestId("typing");

describe("chat status row activity (issue #9)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });

  it("names the open tool and ticks its time and the run's", () => {
    vi.setSystemTime(Date.parse(at(72)));
    show("running", { [RUN_ID]: runActivityOf([bash]) });
    expect(screen.getByTestId("run-activity").textContent).toBe("Bash · 12 s");
    expect(row().textContent).toContain("1 min 12 s in total");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("run-activity").textContent).toBe("Bash · 13 s");
    expect(row().textContent).toContain("1 min 13 s in total");
  });

  it("says how long the model has not answered once no tool is open", () => {
    vi.setSystemTime(Date.parse(at(134)));
    show("running", { [RUN_ID]: runActivityOf([bash, bashDone, ...modelWait]) });
    expect(screen.getByTestId("run-activity").textContent).toBe("waiting on the model · 34 s");
  });

  it("marks a stalled run and keeps saying what it is stuck on", () => {
    vi.setSystemTime(Date.parse(at(500)));
    show("stalled", { [RUN_ID]: runActivityOf(modelWait) });
    expect(row().getAttribute("data-state")).toBe("stalled");
    expect(row().textContent).toContain("ops has shown no progress for a while");
    expect(screen.getByTestId("run-activity").textContent).toBe(
      "waiting on the model · 6 min 40 s",
    );
  });

  it("says only the elapsed time when nothing is known to be open", () => {
    vi.setSystemTime(Date.parse(at(5)));
    show("running", {});
    expect(screen.getByTestId("run-activity").textContent).toBe("5 s in total");
  });
});

describe("chat pane run activity (issue #9)", () => {
  beforeEach(() => {
    installFakeEventSource();
  });

  it("seeds from the run's newest events and follows its frames", async () => {
    const live = run({ id: RUN_ID as RunId, status: "running", startedAt: START });
    const { fetch, calls } = fakeFetch({
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "deploy")] },
      "GET /api/threads/thr_1/messages?afterSeq=1": { messages: [], hasMore: false },
      "GET /api/runs?threadId=thr_1": { runs: [live] },
      [`GET /api/runs/${RUN_ID}/events?limit=100`]: { events: [bash] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/rounds": { rounds: [] },
    });
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await waitFor(() => expect(screen.getByTestId("run-activity").textContent).toMatch(/^Bash · /));
    expect(calls.some((c) => c.path.endsWith(`/api/runs/${RUN_ID}/events?limit=100`))).toBe(true);

    const stream = FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`);
    act(() => stream.emit({ type: "run_event", threadId: THREAD_ID, event: bashDone }));
    await waitFor(() =>
      expect(screen.getByTestId("run-activity").textContent).toMatch(/in total$/),
    );
    act(() => {
      stream.emit({
        type: "run_event",
        threadId: THREAD_ID,
        event: ev(
          7,
          "tool_call",
          { toolUseId: "tu_2", toolName: "mcp__browser__browser_click", input: {} },
          at(130),
        ),
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("run-activity").textContent).toMatch(/^browser_click · /),
    );
  });
});
