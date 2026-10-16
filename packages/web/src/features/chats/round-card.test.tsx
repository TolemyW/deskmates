// @vitest-environment jsdom
// ADR-0005 amendment 6, decision 51 (proposed): under `round-v1` a triaged round is one card with
// who does what, each member's state, the closer, the synthesis as the main text and the members'
// replies collapsed. The 并行 / 依次 toggle is not offered under `round-v1`.

import type { BotId, MessageId, RunId, ThreadRound, WorkspaceId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { NamedThreadMember } from "../../api/types.js";
import {
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { RoundCard, showsRoundCard } from "./round-card.js";

beforeEach(installFakeEventSource);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const names: Record<string, string> = { bot_a: "ann", bot_b: "ben", bot_c: "cat" };
const bodies: Record<string, string> = {
  msg_ben: "K costs 5 per unit.",
  msg_cat: "No stock data for K.",
  msg_close: "Item K: 5 per unit; stock is unknown.",
};

function planned(extra: Partial<NonNullable<ThreadRound["plan"]>> = {}): ThreadRound {
  return {
    workspaceId: "ws_1" as WorkspaceId,
    threadId: THREAD_ID,
    messageId: "msg_1" as MessageId,
    messageSeq: 1,
    authorKind: "human",
    authorId: "user:usr_1",
    excerpt: "What is item K worth?",
    mode: "offer",
    createdAt: "2026-10-16T08:00:00.000Z",
    members: [
      { botId: "bot_a" as BotId, ordinal: 0, state: "skipped", runs: [], outputMessageIds: [] },
      {
        botId: "bot_b" as BotId,
        ordinal: 1,
        state: "replied",
        runId: "run_b" as RunId,
        runs: [{ runId: "run_b" as RunId, relation: "created" }],
        outputMessageIds: ["msg_ben" as MessageId],
      },
      {
        botId: "bot_c" as BotId,
        ordinal: 2,
        state: "failed",
        runId: "run_c" as RunId,
        runs: [{ runId: "run_c" as RunId, relation: "created" }],
        outputMessageIds: ["msg_cat" as MessageId],
      },
    ],
    completed: 3,
    total: 3,
    plan: {
      phase: "closed",
      triageRunId: "run_t" as RunId,
      assignments: [
        { botId: "bot_b" as BotId, task: "unit price of K" },
        { botId: "bot_c" as BotId, task: "units of K in stock" },
      ],
      closerBotId: "bot_a" as BotId,
      closerRunId: "run_close" as RunId,
      closerRunStatus: "succeeded",
      synthesisMessageIds: ["msg_close" as MessageId],
      ...extra,
    },
  };
}

describe("showsRoundCard", () => {
  it("is true only for a planned round under round-v1", () => {
    const round = planned();
    const { plan: _plan, ...unplanned } = round;
    expect(showsRoundCard("round-v1", round)).toBe(true);
    expect(showsRoundCard("owner-v1", round)).toBe(false);
    expect(showsRoundCard(undefined, round)).toBe(false);
    expect(showsRoundCard("round-v1", unplanned)).toBe(false);
    expect(showsRoundCard("round-v1", undefined)).toBe(false);
  });
});

describe("RoundCard", () => {
  const renderCard = (round: ThreadRound) =>
    render(
      <RoundCard
        round={round as ThreadRound & { plan: NonNullable<ThreadRound["plan"]> }}
        botName={(id) => names[id] ?? id}
        actorName={() => "Jia"}
        messageBody={(id) => bodies[id]}
      />,
    );

  it("shows who does what, each state, the closer and the synthesis, replies collapsed", () => {
    renderCard(planned());
    const card = screen.getByTestId("round-card");
    expect(card.textContent).toContain("「What is item K worth?」");
    expect(screen.getByTestId("round-card-phase").textContent).toBe("Done");
    const items = [...card.querySelectorAll(".round-card-assignments li")].map((li) =>
      li.textContent?.trim(),
    );
    expect(items).toEqual(["benunit price of Kreplied", "catunits of K in stockfailed"]);
    expect(card.textContent).not.toContain("taken by another");
    expect(card.textContent).toContain("Closes: ann");
    expect(screen.getByTestId("round-card-synthesis").textContent).toBe(
      "Item K: 5 per unit; stock is unknown.",
    );
    const replies = card.querySelector("details");
    expect(replies?.open).toBe(false);
    expect(replies?.querySelector("summary")?.textContent).toBe("Member replies (2)");
    expect(replies?.textContent).toContain("K costs 5 per unit.");
    expect(replies?.textContent).toContain("No stock data for K.");
  });

  it("says when the closer is still writing and when triage fell back", () => {
    renderCard(
      planned({
        phase: "closing",
        closerRunStatus: "running",
        synthesisMessageIds: [],
      }),
    );
    expect(screen.getByTestId("round-card-phase").textContent).toBe("Writing the answer");
    expect(screen.queryByTestId("round-card-synthesis")).toBeNull();
    expect(screen.getByText("running")).toBeTruthy();
    cleanup();
    renderCard(
      planned({
        phase: "fallback",
        assignments: [],
        reason: "triage failed",
        synthesisMessageIds: [],
      }),
    );
    expect(screen.getByTestId("round-card").textContent).toContain(
      "Not planned (triage failed); routed as usual.",
    );
  });
});

describe("the chat under round-v1", () => {
  const group = [
    ...members,
    { ...(members[0] as NamedThreadMember), botId: "bot_2" as BotId, name: "fin" },
  ];
  const setup = (groupRouting: "round-v1" | "owner-v1") =>
    fakeFetch({
      "GET /api/threads/thr_1": { thread, members: group, groupRouting },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "K?")] },
      "GET /api/threads/thr_1/rounds?limit=20": { rounds: [planned({ phase: "working" })] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });

  it("shows the card instead of the strip and offers no 依次 toggle", async () => {
    const { fetch } = setup("round-v1");
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    expect(await screen.findByTestId("round-card")).toBeTruthy();
    expect(screen.queryByTestId("round-strip")).toBeNull();
    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "@everyone go" },
    });
    expect(screen.queryByTestId("round-mode-toggle")).toBeNull();
  });

  it("keeps the strip and the toggle under owner-v1", async () => {
    const { fetch } = setup("owner-v1");
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    expect(await screen.findByTestId("round-strip")).toBeTruthy();
    expect(screen.queryByTestId("round-card")).toBeNull();
    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "@everyone go" },
    });
    expect(await screen.findByTestId("round-mode-toggle")).toBeTruthy();
  });
});
