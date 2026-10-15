// @vitest-environment jsdom
// T1 (in-process): issue #126. Unfinished work in an open chat is one compact row per bot, not one
// row per run: the row says what the bot is doing or waiting for (queued and approval-blocked work
// is never "running") and how many more runs it has. Expanding a bot lists each unfinished run
// with its exact status, lane, trigger and run link. Summary and list come from the same runs, so
// live frames and reconnect snapshots change both at once and finished runs leave both.

import type { BotId, RunId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { NamedThreadMember, RunView } from "../../api/types.js";
import {
  FakeEventSource,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { ChatRunStatus, groupRunsByBot } from "./chat-run-status.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const names: Record<string, string> = { bot_1: "ops", bot_2: "qa", bot_3: "dbe" };
const botName = (id: string) => names[id] ?? id;
const bodies: Record<string, string> = {
  msg_1: "check the deploy",
  msg_2: "and then   rerun\nthe nightly report",
};

let clock = 0;
function r(extra: Partial<RunView>): RunView {
  clock += 1;
  return run({
    id: `run_${clock}` as RunId,
    createdAt: `2026-09-21T10:00:${String(clock).padStart(2, "0")}.000Z`,
    ...extra,
  });
}
const bot2 = "bot_2" as BotId;
const bot3 = "bot_3" as BotId;

function show(runs: RunView[]) {
  const ui = (list: RunView[]) => (
    <ol>
      <ChatRunStatus
        api={createApiClient({ fetch: fakeFetch({}).fetch })}
        runs={list}
        botName={botName}
        messageBody={(id) => bodies[id]}
        thread={thread}
        memberCount={3}
        onRunUpdated={() => {}}
      />
    </ol>
  );
  const view = render(ui(runs));
  return { rerender: (list: RunView[]) => view.rerender(ui(list)) };
}

const rows = () => screen.queryAllByTestId("typing");
const toggleFor = (name: string) =>
  screen.getByRole("button", { name: new RegExp(` of ${name}$`) });
const runItems = (name: string) =>
  within(screen.getByRole("list", { name: `Unfinished runs of ${name}` })).getAllByRole("listitem");

describe("ChatRunStatus (issue #126)", () => {
  beforeEach(() => {
    clock = 0;
  });

  it("shows one row for a bot with running and queued work, and lists both runs on expansion", () => {
    show([
      r({ status: "running", triggerRef: "msg_1" }),
      r({ status: "queued", triggerRef: "msg_2" }),
    ]);
    expect(rows()).toHaveLength(1);
    const row = rows()[0] as HTMLElement;
    expect(row.textContent).toContain("ops is running…");
    expect(row.textContent).toContain("1 queued");
    expect(row.getAttribute("data-state")).toBe("running");

    const toggle = toggleFor("ops");
    expect(toggle.textContent).toContain("2 runs");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Unfinished runs of ops" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region?.hidden).toBe(false);
    const [first, second] = runItems("ops");
    expect(first?.textContent).toContain("running");
    expect(first?.textContent).toContain("Reply to “check the deploy”");
    expect(second?.textContent).toContain("queued");
    expect(second?.textContent).toContain("Reply to “and then rerun the nightly report”");
    const links = within(screen.getByRole("list", { name: "Unfinished runs of ops" })).getAllByRole(
      "link",
      { name: "Run details" },
    );
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#/runs/run_1", "#/runs/run_2"]);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Unfinished runs of ops" })).toBeNull();
  });

  it("gives several bots one row each, so extra runs never look like extra bots", () => {
    show([
      r({ status: "running" }),
      r({ botId: bot2, status: "queued" }),
      r({ status: "queued" }),
      r({ botId: bot3, status: "running" }),
      r({ botId: bot2, status: "queued" }),
      r({ botId: bot3, status: "queued" }),
      r({ botId: bot3, status: "queued" }),
    ]);
    const texts = rows().map((row) => row.textContent ?? "");
    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatch(/^.*ops is running….*1 queued/);
    expect(texts[1]).toMatch(/qa is queued.*1 queued/);
    expect(texts[2]).toMatch(/dbe is running….*2 queued/);
    // No Stop row: Stop exists only inside an expanded list.
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    fireEvent.click(toggleFor("dbe"));
    expect(runItems("dbe")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Stop dbe/ })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /^Stop ops/ })).toBeNull();
  });

  it("describes approval, browser and continuation waits as waiting, never as running", () => {
    show([
      r({ status: "waiting_approval" }),
      r({ status: "queued" }),
      r({ botId: bot2, status: "waiting_approval_live" }),
      r({ botId: bot3, status: "waiting_continuation" }),
    ]);
    const [ops, qa, dbe] = rows();
    expect(ops?.textContent).toContain("ops is waiting for approval");
    expect(ops?.textContent).toContain("1 queued");
    expect(ops?.getAttribute("data-state")).toBe("approval");
    expect(qa?.textContent).toContain("qa is waiting for approval");
    expect(dbe?.textContent).toContain("dbe is paused until someone continues it");
    for (const row of rows()) {
      expect(row.textContent).not.toContain("running");
      expect(row.querySelector(".typing-dots")).toBeNull();
    }
    fireEvent.click(toggleFor("ops"));
    expect(runItems("ops")[0]?.textContent).toContain("waiting approval");
  });

  it("prefers a running run in the summary even when an older run waits for approval", () => {
    show([r({ status: "waiting_approval" }), r({ status: "running", lane: "background" })]);
    const row = rows()[0] as HTMLElement;
    expect(row.textContent).toContain("ops is running…");
    expect(row.textContent).toContain("1 more waiting");
  });

  it("keeps concurrent runs on both lanes of one bot", () => {
    show([
      r({ status: "running", lane: "interactive" }),
      r({ status: "running", lane: "background", triggerKind: "cron", triggerRef: "0" }),
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("1 more running");
    fireEvent.click(toggleFor("ops"));
    const [interactive, background] = runItems("ops");
    expect(interactive?.textContent).toContain("interactive lane");
    expect(background?.textContent).toContain("background lane");
    expect(background?.textContent).toContain("Scheduled task");
    expect(screen.getAllByRole("button", { name: /^Stop ops \(running\)/ })).toHaveLength(2);
  });

  it("updates summary and expanded list together and drops finished runs", () => {
    const a = r({ status: "running" });
    const b = r({ status: "queued" });
    const c = r({ botId: bot2, status: "waiting_approval" });
    const { rerender } = show([a, b, c]);
    fireEvent.click(toggleFor("ops"));
    expect(runItems("ops")).toHaveLength(2);

    // `a` finished; `b` started. The caller passes only unfinished runs.
    rerender([{ ...b, status: "running" }, c]);
    expect(rows()[0]?.textContent).toContain("ops is running…");
    expect(rows()[0]?.textContent).not.toContain("queued");
    expect(toggleFor("ops").textContent).toContain("1 run");
    expect(runItems("ops")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Run details", hidden: false })).toBeTruthy();

    rerender([c]);
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText(/ops is/)).toBeNull();
    rerender([]);
    expect(rows()).toHaveLength(0);
  });

  it("groups by bot in order of each bot's oldest run", () => {
    const groups = groupRunsByBot([
      r({ botId: bot2, status: "queued" }),
      r({ status: "waiting_browser" }),
      r({ status: "queued" }),
    ]);
    expect(groups.map((g) => [g.botId, g.state, g.current.id, g.queued])).toEqual([
      ["bot_2", "queued", "run_1", 0],
      ["bot_1", "browser", "run_2", 1],
    ]);
  });
});

describe("grouped run status in the chat pane (issue #126)", () => {
  beforeEach(() => {
    clock = 0;
    installFakeEventSource();
  });

  const group: NamedThreadMember[] = [
    ...members,
    { ...(members[0] as NamedThreadMember), botId: bot2, name: "qa" },
  ];

  it("counts a bot's runs per status in the header instead of repeating the status", async () => {
    const queued = [1, 2, 3].map((n) => r({ status: "queued", triggerRef: `msg_${n}` }));
    const { fetch } = fakeFetch({
      "GET /api/threads/thr_1": { thread, members: group },
      "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "go")] },
      "GET /api/threads/thr_1/messages?afterSeq=1": { messages: [], hasMore: false },
      "GET /api/runs?threadId=thr_1": { runs: [r({ status: "running" }), ...queued] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/rounds": { rounds: [] },
    });
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await waitFor(() => expect(screen.getAllByText(/queued ×3/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/queued, queued/)).toBeNull();
  });

  it("removes the flat Stop row, follows live frames and reconciles on reconnect", async () => {
    const opsRunning = r({ status: "running", triggerRef: "msg_1" });
    const opsQueued = r({ status: "queued", triggerRef: "msg_2" });
    const qaApproval = r({ botId: bot2, status: "waiting_approval" });
    let snapshot: RunView[] = [opsRunning, opsQueued, qaApproval];
    const { fetch } = fakeFetch({
      "GET /api/threads/thr_1": { thread, members: group },
      "GET /api/threads/thr_1/messages": {
        messages: [message(1, "human", "check the deploy"), message(2, "human", "and the report")],
      },
      "GET /api/threads/thr_1/messages?afterSeq=2": { messages: [], hasMore: false },
      "GET /api/runs?threadId=thr_1": () => ({ runs: snapshot }),
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/rounds": { rounds: [] },
    });
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Stop work in this chat" })).toBeNull();
    expect(rows()[0]?.textContent).toContain("ops is running…");
    expect(rows()[1]?.textContent).toContain("qa is waiting for approval");
    fireEvent.click(toggleFor("ops"));
    expect(runItems("ops")[0]?.textContent).toContain("Reply to “check the deploy”");

    const stream = FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`);
    act(() => {
      stream.emit({
        type: "run_status",
        threadId: THREAD_ID,
        run: { ...opsRunning, status: "succeeded" },
      });
    });
    await waitFor(() => expect(rows()[0]?.textContent).toContain("ops is queued"));
    expect(runItems("ops")).toHaveLength(1);
    expect(toggleFor("ops").getAttribute("aria-expanded")).toBe("true");

    // Frames lost while the stream was down: the reconnect snapshot is the truth.
    snapshot = [
      { ...opsRunning, status: "succeeded" },
      { ...opsQueued, status: "running" },
      { ...qaApproval, status: "cancelled" },
    ];
    act(() => {
      stream.drop();
      stream.open();
    });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]?.textContent).toContain("ops is running…");
    expect(runItems("ops")).toHaveLength(1);
    expect(runItems("ops")[0]?.textContent).toContain("running");
    expect(screen.queryByText(/qa is/)).toBeNull();
  });
});
