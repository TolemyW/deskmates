// @vitest-environment jsdom
// ADR-0005 amendment 4, decision 36: the current-round strip shows the newest top-level round with
// its mode, n/m complete and each member's state; an older failed round never replaces it.

import type { BotId, MessageId, ThreadRound, WorkspaceId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { THREAD_ID } from "../../test-support/fixtures.js";
import { RoundStrip, currentRound } from "./round-strip.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const names: Record<string, string> = { bot_a: "ann", bot_b: "ben", bot_c: "cat", bot_d: "dan" };

function round(
  messageId: string,
  states: ThreadRound["members"][number]["state"][],
  extra: Partial<ThreadRound> = {},
): ThreadRound {
  const members = states.map((state, ordinal) => ({
    botId: Object.keys(names)[ordinal] as BotId,
    ordinal,
    state,
    runs: [],
    outputMessageIds: [],
  }));
  return {
    workspaceId: "ws_1" as WorkspaceId,
    threadId: THREAD_ID,
    messageId: messageId as MessageId,
    messageSeq: 1,
    authorKind: "human",
    authorId: "user:usr_1",
    excerpt: "@everyone price check",
    mode: "parallel",
    createdAt: "2026-10-13T08:00:00.000Z",
    members,
    completed: states.filter((s) => ["replied", "silent", "failed"].includes(s)).length,
    total: members.length,
    ...extra,
  };
}

it("picks the newest top-level round, never a nested one or an older one", () => {
  const nested = round("msg_9", ["queued"], { parentMessageId: "msg_8" as MessageId });
  const latest = round("msg_8", ["running"]);
  const older = round("msg_1", ["failed"]);
  expect(currentRound([nested, latest, older])?.messageId).toBe("msg_8");
});

it("shows mode, n/m done and each member's state, with retry only for a failure", async () => {
  const retryRoundMember = vi.fn(async () => ({}));
  const onChanged = vi.fn();
  render(
    <RoundStrip
      round={round("msg_2", ["replied", "running", "silent", "failed"])}
      api={{ retryRoundMember } as unknown as ApiClient}
      botName={(id) => names[id] ?? id}
      actorName={() => "Jia"}
      onChanged={onChanged}
    />,
  );
  const strip = screen.getByTestId("round-strip");
  expect(strip.textContent).toContain("This round");
  expect(strip.textContent).toContain("Jia");
  expect(strip.textContent).toContain("「@everyone price check」");
  expect(strip.textContent).toContain("Parallel");
  expect(strip.textContent).toContain("3/4 done");
  expect(strip.textContent).toContain("replied");
  expect(strip.textContent).toContain("running");
  expect(strip.textContent).toContain("no reply");
  expect(strip.textContent).toContain("failed");
  const retries = screen.getAllByRole("button", { name: "Retry" });
  expect(retries).toHaveLength(1);
  fireEvent.click(retries[0] as HTMLElement);
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(retryRoundMember).toHaveBeenCalledWith(THREAD_ID, "msg_2", "bot_d");
});

it("renders nothing without a round", () => {
  const { container } = render(
    <RoundStrip
      round={undefined}
      api={{} as ApiClient}
      botName={(id) => id}
      actorName={(id) => id}
      onChanged={() => {}}
    />,
  );
  expect(container.textContent).toBe("");
});
