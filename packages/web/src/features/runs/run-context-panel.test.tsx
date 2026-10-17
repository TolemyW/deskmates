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
  maxContextTokens: null,
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

// ADR-0016 amendment 2 decisions 15 and 16: the panel shows the continuation limit the run froze
// in `config.continuationLimit`; `null` there is `off` (no limit), and a run from before the
// limits were frozen keeps the old default of 2.
it.each([
  [{ limitsVersion: 1, continuationLimit: null, continuationCount: 3 }, /used: 3; no limit/],
  [{ limitsVersion: 1, continuationLimit: 5, continuationCount: 1 }, /used: 1 of 5/],
  [{ limitsVersion: 1, continuationLimit: 0 }, /used: 0 of 0/],
  [{ continuationCount: 1 }, /used: 1 of 2/],
])("shows the frozen continuation limit %j", async (config, text) => {
  const api = { getRunContext: vi.fn(async () => metrics), decideContinuation: vi.fn() };
  render(
    <RunContextPanel
      api={api}
      run={run({ status: "running", config })}
      events={[]}
      onRunChanged={vi.fn()}
    />,
  );
  expect(screen.getByText(text)).toBeTruthy();
  await waitFor(() => expect(api.getRunContext).toHaveBeenCalledOnce());
});

// Issue #9: the section sizes and the prompt hash the route already returned, and peak input
// against the window when the CLI was given one; without a window there is no meter.
it("shows section sizes, the prompt hash and peak input against the window", async () => {
  const measured: RunContextMetrics = {
    ...metrics,
    turns: 4,
    peakInputTokens: 150000,
    contextSections: { soul: 820, memory: 240, guidance: 9100 },
    systemPromptSha256: "3f1c0d9e2b7a4c6d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d",
    maxContextTokens: 200000,
    modelRequests: { count: 4, distinctSystemHashes: 2, changedWithinAttempt: true },
  };
  const api = { getRunContext: vi.fn(async () => measured), decideContinuation: vi.fn() };
  render(<RunContextPanel api={api} run={run()} events={[]} onRunChanged={vi.fn()} />);
  const sections = await screen.findByRole("list", { name: "System prompt section sizes" });
  expect([...sections.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "guidance9,100 characters",
    "soul820 characters",
    "memory240 characters",
  ]);
  const hash = screen.getByText("3f1c0d9e2b7a");
  expect(hash.getAttribute("title")).toBe(measured.systemPromptSha256);
  expect(screen.getByText("200,000 tokens")).toBeTruthy();
  const meter = screen.getByRole("meter") as HTMLMeterElement;
  expect([meter.value, meter.max]).toEqual([150000, 200000]);
  expect(screen.getByText("75% of the window")).toBeTruthy();
  expect(screen.getByText("4 requests, 2 distinct system prompts")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("changed within one attempt");
});

it("has no meter and says so when the CLI reported no window", async () => {
  const api = {
    getRunContext: vi.fn(async () => ({ ...metrics, peakInputTokens: 1000 })),
    decideContinuation: vi.fn(),
  };
  render(<RunContextPanel api={api} run={run()} events={[]} onRunChanged={vi.fn()} />);
  expect(await screen.findByText("Not reported: the CLI chose its own window")).toBeTruthy();
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.getByText("No section sizes were recorded for this run.")).toBeTruthy();
});
