// @vitest-environment jsdom
import type { RunContextMetrics } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { run, runEvent } from "../../test-support/fixtures.js";
import { RunContextPanel } from "./run-context-panel.js";

afterEach(cleanup);
const metrics: RunContextMetrics = {
  turns: 0,
  peakInputTokens: null,
  p95InputTokens: null,
  cacheHitRatio: null,
  compactions: [],
  contextSections: null,
  systemPromptSha256: null,
  modelRequests: { count: 0, distinctSystemHashes: 0, changedWithinAttempt: false },
};

it("keeps absent measurements unknown and displays memory exclusion receipts", async () => {
  const api = { getRunContext: vi.fn(async () => metrics), decideContinuation: vi.fn() };
  render(
    <RunContextPanel
      api={api}
      run={run({ status: "silent" })}
      events={[
        runEvent(1, "memory_index", {
          considered: 8,
          pinned: 2,
          untrusted: 3,
          budget: 2,
          ineligible: 1,
        }),
      ]}
      onRunChanged={vi.fn()}
    />,
  );
  await waitFor(() => expect(api.getRunContext).toHaveBeenCalledOnce());
  expect(screen.getByText(/does not confirm task completion/)).toBeTruthy();
  expect(screen.getAllByText("Unknown tokens")).toHaveLength(2);
  expect(screen.getByText(/Pinned memory index considered: 8, included: 2/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue run" })).toBeNull();
});

it("continues the same run and surfaces a rejected stop without hiding the controls", async () => {
  const parked = run({
    status: "waiting_continuation",
    config: { handoffPath: "/work/handoff.md", continuationCount: 1 },
  });
  const onRunChanged = vi.fn();
  const api = {
    getRunContext: vi.fn(async () => metrics),
    decideContinuation: vi.fn(async (_id: string, decision: string) => {
      if (decision === "stop") throw new Error("Decision already taken");
      return { run: { ...parked, status: "running" as const } };
    }),
  };
  render(<RunContextPanel api={api} run={parked} events={[]} onRunChanged={onRunChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue run" }));
  await waitFor(() =>
    expect(onRunChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: parked.id, status: "running" }),
    ),
  );
  expect(api.decideContinuation).toHaveBeenCalledWith(parked.id, "continue");
  fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Decision already taken");
});

it("discards an older context reply after another refresh supersedes it", async () => {
  let resolveFirst: (value: RunContextMetrics) => void = () => {};
  const api = {
    getRunContext: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<RunContextMetrics>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ ...metrics, peakInputTokens: 42 }),
    decideContinuation: vi.fn(),
  };
  render(<RunContextPanel api={api} run={run()} events={[]} onRunChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh measurements" }));
  expect(await screen.findByText("42 tokens")).toBeTruthy();
  resolveFirst({ ...metrics, peakInputTokens: 99 });
  await waitFor(() => expect(screen.queryByText("99 tokens")).toBeNull());
});
