// @vitest-environment jsdom
import { type RunTimelineEvent, buildRunTimeline, timelineMark } from "@deskmates/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../../test-support/fixtures.js";
import { RunTimelinePanel } from "./run-timeline.js";

afterEach(cleanup);

const T0 = Date.parse("2026-10-14T10:00:00.000Z");
const mark = (
  name: Parameters<typeof timelineMark>[0],
  offsetMs: number,
  attrs: Record<string, unknown> = {},
): RunTimelineEvent => ({
  kind: "log",
  attempt: 1,
  payload: timelineMark(name, new Date(T0 + offsetMs), attrs),
  ts: new Date(T0 + offsetMs).toISOString(),
});

it("lists every stage, says which were not observed and names the longest wait", async () => {
  const timeline = buildRunTimeline({
    runId: "run_1",
    status: "succeeded",
    attempt: 1,
    createdAt: new Date(T0).toISOString(),
    finishedAt: new Date(T0 + 9000).toISOString(),
    events: [
      mark("attempt_started", 100, { start: "fresh", session: "resumed" }),
      mark("sandbox_ready", 8000, { sandbox: "created" }),
      mark("sidecar_spawned", 8100),
      mark("run_ended", 9000, { outcome: "completed", replyPosted: true }),
      { kind: "model_retry", attempt: 1, payload: {}, ts: new Date(T0 + 8500).toISOString() },
    ],
  });
  const api = { getRunTimeline: vi.fn(async () => timeline) };
  render(<RunTimelinePanel api={api} run={run({ status: "succeeded" })} />);
  await waitFor(() => expect(screen.getByText("Attempt 1")).toBeTruthy());
  expect(
    screen.getByText(/fresh start · resumed session · new container · 1 model retry/),
  ).toBeTruthy();
  expect(screen.getByText("Longest wait: before Container ready")).toBeTruthy();
  expect(screen.getByText("Submitted to finished: 9.0 s")).toBeTruthy();
  const list = screen.getByRole("list");
  expect(within(list).getAllByRole("listitem")).toHaveLength(16);
  // Process stages the sidecar never reported stay unfilled.
  expect(within(list).getAllByText("not observed")).toHaveLength(9);
  const slowest = within(list).getByText("Container ready").closest("li");
  expect(slowest?.className).toContain("slowest");
  expect(within(slowest as HTMLElement).getByText("+8.0 s")).toBeTruthy();
});

it("says what an open attempt is waiting for", async () => {
  const timeline = buildRunTimeline({
    runId: "run_1",
    status: "queued",
    attempt: 0,
    createdAt: new Date(T0).toISOString(),
    events: [],
  });
  render(
    <RunTimelinePanel
      api={{ getRunTimeline: vi.fn(async () => timeline) }}
      run={run({ status: "queued" })}
    />,
  );
  await waitFor(() => expect(screen.getByText("Waiting for: Left the queue")).toBeTruthy());
  expect(screen.queryByText(/Submitted to finished/)).toBeNull();
});

it("shows a failed read without inventing a timeline", async () => {
  render(
    <RunTimelinePanel
      api={{ getRunTimeline: vi.fn(async () => Promise.reject(new Error("offline"))) }}
      run={run()}
    />,
  );
  await waitFor(() => expect(screen.getByText(/Timeline unavailable/)).toBeTruthy());
  expect(screen.queryByRole("list")).toBeNull();
});
