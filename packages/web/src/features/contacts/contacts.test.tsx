// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { BotId, ThreadSummary } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  BOT_ID,
  WS_ID,
  bot,
  fakeFetch,
  run,
  thread,
  workspace,
} from "../../test-support/fixtures.js";
import { chatTitle, memberIdsOf } from "../chats/thread-rail.js";
import { feedItemOf } from "./bot-activity.js";
import { ContactsScreen, latestRunByBot, privateChatOf } from "./contacts.js";

afterEach(cleanup);

const summary = (t: Partial<ThreadSummary>): ThreadSummary => ({ ...thread, memberIds: [], ...t });

describe("contacts helpers", () => {
  it("finds a bot's private chat and ignores groups and bus threads", () => {
    const other = "bot_2" as BotId;
    const threads = [
      summary({ id: "thr_group" as ThreadSummary["id"], memberIds: [BOT_ID, other] }),
      summary({ id: "thr_bus" as ThreadSummary["id"], kind: "bus", memberIds: [BOT_ID] }),
      summary({
        id: "thr_old" as ThreadSummary["id"],
        memberIds: [BOT_ID],
        updatedAt: "2026-09-20T00:00:00Z",
      }),
      summary({
        id: "thr_new" as ThreadSummary["id"],
        memberIds: [BOT_ID],
        updatedAt: "2026-09-22T00:00:00Z",
      }),
    ];
    expect(privateChatOf(threads, BOT_ID)?.id).toBe("thr_new");
    expect(privateChatOf(threads, other)).toBeUndefined();
  });

  it("keeps the newest run per bot", () => {
    const latest = latestRunByBot([
      run({ id: "run_a" as never, createdAt: "2026-09-21T10:00:00Z" }),
      run({ id: "run_b" as never, createdAt: "2026-09-21T11:00:00Z", status: "failed" }),
    ]);
    expect(latest.get(BOT_ID)?.id).toBe("run_b");
  });

  it("names a private chat after its bot when it has no title", () => {
    const names = (id: BotId) => (id === BOT_ID ? "ops" : undefined);
    expect(chatTitle(summary({ title: "", memberIds: [BOT_ID] }), names)).toBe("ops");
    expect(chatTitle(summary({ title: "Morning check", memberIds: [BOT_ID] }), names)).toBe(
      "Morning check",
    );
    expect(memberIdsOf(thread)).toEqual([]);
  });

  it("turns a run into a channel post that says what happened", () => {
    expect(feedItemOf(run({ status: "failed", error: "boom" }))).toMatchObject({
      title: "A run failed",
      detail: "boom",
    });
    expect(
      feedItemOf(
        run({
          status: "succeeded",
          summary: {
            done: "wrote the brief",
            reply: "all good",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
          },
        }),
      ),
    ).toMatchObject({ title: "wrote the brief", detail: "all good" });
    expect(feedItemOf(run({ status: "waiting_approval" })).title).toBe("Waiting for an approval");
  });
});

describe("ContactsScreen", () => {
  it("lists bots with their latest status and opens the existing private chat", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      [`GET /api/bots?workspaceId=${WS_ID}&offset=0&limit=50`]: {
        bots: [bot],
        offset: 0,
        limit: 50,
        total: 1,
      },
      [`GET /api/runs/latest-by-bot?workspaceId=${WS_ID}`]: {
        runs: [run({ status: "succeeded" })],
      },
      [`GET /api/runs?botId=${BOT_ID}`]: { runs: [run({ status: "succeeded" })] },
      [`GET /api/threads?workspaceId=${WS_ID}`]: { threads: [summary({ memberIds: [BOT_ID] })] },
      [`POST /api/bots/${BOT_ID}/private-chat`]: { thread, members: [] },
    });
    render(<ContactsScreen api={createApiClient({ fetch })} />);
    await screen.findByRole("heading", { name: "ops" });
    expect(
      (await screen.findAllByText("succeeded"))[0]
        ?.closest("[data-gb-ui='pill']")
        ?.getAttribute("data-tone"),
    ).toBe("success");
    fireEvent.click(screen.getByRole("button", { name: "Message ops" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      `/api/bots/${BOT_ID}/private-chat`,
    ]);
  });
});
