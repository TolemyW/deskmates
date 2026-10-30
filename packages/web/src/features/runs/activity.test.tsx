// @vitest-environment jsdom
// ADR-0033 decisions 1, 2 and 7: one card per run grouped by round, filters, the bounded summary
// with an honest fallback, and the original one disclosure away.

import type {
  BotId,
  MessageId,
  RunEvent,
  RunId,
  ThreadRound,
  WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THREAD_ID, run } from "../../test-support/fixtures.js";
import { ActivityPanel, groupActivity } from "./activity.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const roundOf = (messageId: string, excerpt: string): ThreadRound => ({
  workspaceId: "ws_1" as WorkspaceId,
  threadId: THREAD_ID,
  messageId: messageId as MessageId,
  messageSeq: 1,
  authorKind: "human",
  authorId: "user:usr_1",
  excerpt,
  mode: "parallel",
  createdAt: "2026-10-13T08:00:00.000Z",
  members: [],
  completed: 0,
  total: 0,
});

const names: Record<string, string> = { bot_a: "ann", bot_b: "ben" };

const runs = [
  run({
    id: "run_old" as RunId,
    botId: "bot_a" as BotId,
    status: "failed",
    error: "upstream 529",
    roundMessageIds: ["msg_old"],
    createdAt: "2026-10-13T07:00:00.000Z",
  }),
  run({
    id: "run_a" as RunId,
    botId: "bot_a" as BotId,
    status: "succeeded",
    summary: {
      done: "quoted",
      reply: "A long original reply with every detail.",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
    },
    roundMessageIds: ["msg_new"],
    activitySummary: {
      runId: "run_a" as RunId,
      sourceVersion: "a1-succeeded",
      status: "ready",
      text: "报价已比较完毕，最低价来自供应商乙。",
      summaryRunId: "run_job" as RunId,
    },
    createdAt: "2026-10-13T08:01:00.000Z",
  }),
  run({
    id: "run_b" as RunId,
    botId: "bot_b" as BotId,
    status: "failed",
    error: "browser crashed\nstack…",
    roundMessageIds: ["msg_new"],
    activitySummary: { runId: "run_b" as RunId, sourceVersion: "a1-failed", status: "pending" },
    createdAt: "2026-10-13T08:02:00.000Z",
  }),
  run({
    id: "run_cron" as RunId,
    botId: "bot_b" as BotId,
    lane: "background",
    triggerKind: "cron",
    triggerRef: "nightly",
    status: "waiting_approval",
    createdAt: "2026-10-13T08:03:00.000Z",
  }),
  run({
    id: "run_job" as RunId,
    botId: "bot_a" as BotId,
    lane: "background",
    triggerKind: "cron",
    triggerRef: "activity_summary:run_a:a1-succeeded",
    status: "succeeded",
    config: { runType: "activity_summary" },
  }),
];
const rounds = [roundOf("msg_new", "@everyone compare quotes"), roundOf("msg_old", "earlier ask")];

describe("groupActivity", () => {
  it("groups by round, keeps other runs under their trigger and drops summary jobs", () => {
    const groups = groupActivity(runs, rounds);
    expect(groups.map((g) => g.key)).toEqual([
      "trigger:cron:nightly",
      "round:msg_new",
      "round:msg_old",
    ]);
    expect(groups[1]?.runs.map((r) => r.id)).toEqual(["run_a", "run_b"]);
  });
});

describe("ActivityPanel", () => {
  const panel = (extra: Partial<Parameters<typeof ActivityPanel>[0]> = {}) =>
    render(
      <ActivityPanel
        runs={runs}
        rounds={rounds}
        currentRoundId="msg_new"
        botName={(id) => names[id] ?? id}
        actorName={() => "Jia"}
        {...extra}
      />,
    );

  it("shows the current round by default: one card per run, the AI label, an honest fallback", () => {
    panel();
    const cards = screen.getAllByTestId("activity-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText("AI summary")).toBeTruthy();
    expect(cards[0]?.textContent).toContain("报价已比较完毕");
    expect(cards[1]?.textContent).toContain("Summary on its way");
    expect(cards[1]?.textContent).toContain("browser crashed");
    expect(cards[1]?.textContent).not.toContain("stack");
    expect(screen.getByText("Jia: “@everyone compare quotes”")).toBeTruthy();
  });

  it("All shows earlier rounds collapsed and other triggers; the lane filter narrows", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByTestId("activity-card")).toHaveLength(4);
    const groups = document.querySelectorAll("details.activity-group");
    expect((groups[0] as HTMLDetailsElement).open).toBe(true);
    expect((groups[2] as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Scheduled work" }));
    const cards = screen.getAllByTestId("activity-card");
    expect(cards).toHaveLength(1);
    expect(
      within(cards[0] as HTMLElement).getByRole("link", { name: "Go to approval" }),
    ).toBeTruthy();
  });

  it("Original opens the raw reply, error, retries, tool calls and the run record", async () => {
    const events: RunEvent[] = [
      {
        runId: "run_b" as RunId,
        seq: 1,
        kind: "model_retry",
        ts: "2026-10-13T08:02:01.000Z",
        payload: { attempt: 1, maxRetries: 10, retryDelayMs: 2000, errorStatus: 529 },
      },
      {
        runId: "run_b" as RunId,
        seq: 2,
        kind: "tool_call",
        ts: "2026-10-13T08:02:02.000Z",
        payload: { toolName: "browser_navigate" },
      },
    ] as RunEvent[];
    const loadEvents = vi.fn(async () => events);
    panel({ loadEvents });
    const card = screen.getAllByTestId("activity-card")[1] as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Original" }));
    const raw = await within(card).findByTestId("activity-raw");
    expect(raw.textContent).toContain("stack…");
    expect(await within(card).findByText(/Model retry 1 of 10: HTTP 529/)).toBeTruthy();
    expect(raw.textContent).toContain("browser_navigate");
    expect(within(raw).getByRole("link").getAttribute("href")).toBe("#/runs/run_b");
    expect(loadEvents).toHaveBeenCalledWith("run_b");
  });

  it("Original counts desktop network denials and names their hosts (ADR-0048 A4)", async () => {
    const denial = (seq: number, host: string) =>
      ({
        runId: "run_b" as RunId,
        seq,
        kind: "log",
        ts: "2026-10-13T08:02:03.000Z",
        payload: { source: "desktop", op: "egress_denied", level: "warn", host, kind: "hard_deny" },
      }) as RunEvent;
    const loadEvents = vi.fn(async () => [
      denial(1, "10.0.0.5"),
      denial(2, "intranet.example"),
      denial(3, "10.0.0.5"),
    ]);
    panel({ loadEvents });
    const card = screen.getAllByTestId("activity-card")[1] as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Original" }));
    const line = await within(card).findByTestId("activity-desktop-denials");
    expect(line.textContent).toBe("Desktop network denials: 3 (10.0.0.5, intranet.example)");
  });

  it("Retry asks for the failed member of that round", async () => {
    const onRetry = vi.fn(async () => {});
    panel({ onRetry });
    const card = screen.getAllByTestId("activity-card")[1] as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("msg_new", "bot_b");
    expect(
      within(screen.getAllByTestId("activity-card")[0] as HTMLElement).queryByRole("button", {
        name: "Retry",
      }),
    ).toBeNull();
  });
});

it("labels background chat replies as bot collaboration while keeping actual schedules distinct", () => {
  const collaboration = run({
    id: "run_bus" as RunId,
    lane: "background",
    triggerKind: "thread_message",
    status: "silent",
  });
  const scheduled = run({
    id: "run_cron" as RunId,
    lane: "background",
    triggerKind: "cron",
    status: "silent",
  });
  render(<ActivityPanel runs={[collaboration, scheduled]} botName={() => "assistant"} />);
  expect(screen.getAllByText("Bot collaboration")).toHaveLength(1);
  expect(screen.getAllByText("Scheduled work").length).toBeGreaterThan(0);
});
