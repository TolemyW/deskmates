// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { BotId, SessionRoles, ThreadSummary } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
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
      title: "Work failed",
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
    ).toMatchObject({ title: "Finished work", detail: "wrote the brief" });
    const bounded = feedItemOf(
      run({
        status: "succeeded",
        summary: {
          done: "完成".repeat(80),
          reply: "复核结果".repeat(80),
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
        },
      }),
    );
    expect(bounded.title).toBe("Finished work");
    expect(bounded.detail).toMatch(/…$/);
    expect(bounded.detail).toHaveLength(50);
    expect(feedItemOf(run({ status: "waiting_approval" })).title).toBe("Waiting for an approval");
  });

  it("keeps failed background maintenance out of the latest work state but visible in history", () => {
    const work = run({
      id: "run_work" as never,
      status: "succeeded",
      createdAt: "2026-10-20T10:00:00Z",
    });
    const maintenance = run({
      id: "run_background" as never,
      status: "failed",
      triggerKind: "cron",
      config: { runType: "memory_recheck" },
      error: "model unavailable",
      createdAt: "2026-10-20T11:00:00Z",
    });
    expect(latestRunByBot([work, maintenance]).get(BOT_ID)?.id).toBe(work.id);
    expect(feedItemOf(maintenance)).toMatchObject({
      title: "Background processing",
      detail: "model unavailable",
    });
  });
});

describe("ContactsScreen", () => {
  it("shows a terminal state for a deleted bot profile", async () => {
    const { fetch } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      [`GET /api/bots?workspaceId=${WS_ID}&offset=0&limit=50`]: {
        bots: [bot],
        offset: 0,
        limit: 50,
        total: 1,
      },
      [`GET /api/runs/latest-by-bot?workspaceId=${WS_ID}`]: { runs: [] },
    });
    render(<ContactsScreen api={createApiClient({ fetch })} botId="deleted_bot" />);
    expect(await screen.findByTestId("deleted-object")).toHaveTextContent(
      "This item is no longer available",
    );
    expect(screen.queryByRole("button", { name: /Message deleted_bot/ })).toBeNull();
  });

  it("does not report a failed profile lookup as deleted and allows retry", async () => {
    let failed = true;
    const { fetch } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": () => (failed ? new Error("Roster unavailable") : { bots: [] }),
      [`GET /api/bots?workspaceId=${WS_ID}&offset=0&limit=50`]: {
        bots: [],
        offset: 0,
        limit: 50,
        total: 0,
      },
      [`GET /api/runs/latest-by-bot?workspaceId=${WS_ID}`]: { runs: [] },
    });
    render(<ContactsScreen api={createApiClient({ fetch })} botId={BOT_ID} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Roster unavailable");
    expect(screen.queryByTestId("deleted-object")).toBeNull();
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("deleted-object");
    expect(screen.queryByRole("alert")).toBeNull();
  });

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
      (await screen.findAllByText("complete"))[0]
        ?.closest("[data-gb-ui='pill']")
        ?.getAttribute("data-tone"),
    ).toBe("success");
    fireEvent.click(screen.getByRole("button", { name: "Chat with ops" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      `/api/bots/${BOT_ID}/private-chat`,
    ]);
  });

  it("marks the default bot in the rail and makes another bot the default from its profile (ADR-0051)", async () => {
    const assistant = { ...bot, id: "bot_assistant" as BotId, name: "assistant" };
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [{ ...workspace, defaultBotId: assistant.id }] },
      "GET /api/bots": { bots: [assistant, bot] },
      [`GET /api/bots?workspaceId=${WS_ID}&offset=0&limit=50`]: {
        bots: [assistant, bot],
        offset: 0,
        limit: 50,
        total: 2,
      },
      [`GET /api/runs/latest-by-bot?workspaceId=${WS_ID}`]: { runs: [] },
      "GET /api/config": { defaultModel: "m", cheapModel: "c", models: [] },
      [`PUT /api/workspaces/${WS_ID}/default-bot`]: {
        workspace: { ...workspace, defaultBotId: BOT_ID },
      },
    });
    render(<ContactsScreen api={createApiClient({ fetch })} botId={BOT_ID} />);
    const rail = await screen.findByRole("link", { name: /assistant/ });
    expect(within(rail).getByText("Default").closest("[data-gb-ui='pill']")).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Make default" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PUT")).toMatchObject({
        path: `/api/workspaces/${WS_ID}/default-bot`,
        body: { botId: BOT_ID },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Make default" })).toBeNull());
    const profile = screen.getByRole("heading", { level: 1, name: bot.name }).closest("header");
    expect(within(profile as HTMLElement).getByText("Default")).toBeInTheDocument();
  });

  it("offers no Make default to a Member", async () => {
    const { fetch } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      [`GET /api/bots?workspaceId=${WS_ID}&offset=0&limit=50`]: {
        bots: [bot],
        offset: 0,
        limit: 50,
        total: 1,
      },
      [`GET /api/runs/latest-by-bot?workspaceId=${WS_ID}`]: { runs: [] },
    });
    const roles: SessionRoles = {
      tenantRole: "member",
      platformMaintainer: false,
      workspaceRoles: { [WS_ID]: "member" },
    };
    render(
      <SessionRolesProvider roles={roles} actorId="user:member">
        <ContactsScreen api={createApiClient({ fetch })} botId={BOT_ID} />
      </SessionRolesProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: bot.name });
    expect(screen.queryByRole("button", { name: "Make default" })).toBeNull();
  });

  it("states the bot @name rule, validates live and offers a valid suggestion", async () => {
    const { fetch } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      [`GET /api/bots?workspaceId=${WS_ID}&offset=0&limit=50`]: {
        bots: [bot],
        offset: 0,
        limit: 50,
        total: 1,
      },
      [`GET /api/runs/latest-by-bot?workspaceId=${WS_ID}`]: { runs: [] },
    });
    render(<ContactsScreen api={createApiClient({ fetch })} />);
    fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
    const name = screen.getByRole("textbox", { name: "@name" });
    expect(screen.getByText(/Use letters A–Z, numbers/)).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "Sales Helper!" } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("not a valid @name");
    expect(screen.getByRole("button", { name: "Create Bot" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use @Sales-Helper" }));
    expect(name).toHaveValue("Sales-Helper");
    expect(name).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Create Bot" })).toBeEnabled();
  });

  it("shows no invented run status to a Guest who cannot read runs", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      [`GET /api/bots?workspaceId=${WS_ID}&offset=0&limit=50`]: {
        bots: [bot],
        offset: 0,
        limit: 50,
        total: 1,
      },
    });
    const roles: SessionRoles = {
      tenantRole: "guest",
      platformMaintainer: false,
      workspaceRoles: { [WS_ID]: "guest" },
    };
    render(
      <SessionRolesProvider roles={roles} actorId="user:guest">
        <ContactsScreen api={createApiClient({ fetch })} />
      </SessionRolesProvider>,
    );
    await screen.findByRole("heading", { name: "ops" });
    expect(screen.queryByText("never ran")).toBeNull();
    expect(screen.queryByText("No activity yet")).toBeNull();
    expect(calls.some((call) => call.path.includes("/api/runs"))).toBe(false);
  });
});
