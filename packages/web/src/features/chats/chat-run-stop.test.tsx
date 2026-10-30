// @vitest-environment jsdom
// T1 (in-process): issue #76, through the grouped status of issue #126. Each unfinished run of
// this chat has its own Stop in its bot's expanded run list; Stop names the bot, status and
// trigger of the run it targets, asks before cancelling and says what is and is not stopped. It
// uses the existing `POST /api/runs/:id/cancel`; the Gateway decides permission. No bulk stop.

import type { RunId, SessionRoles, Thread } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { type RouteTable, fakeFetch, run, thread } from "../../test-support/fixtures.js";
import { ChatRunStatus } from "./chat-run-status.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const names: Record<string, string> = { bot_1: "ops", bot_2: "qa" };
const botName = (id: string) => names[id] ?? id;
const bodies: Record<string, string> = { msg_1: "check the deploy" };
const MEMBER: SessionRoles = { tenantRole: "member", platformMaintainer: false };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function view(fetch: typeof globalThis.fetch, list: RunView[], onRunUpdated = vi.fn()) {
  return (
    <ol>
      <ChatRunStatus
        api={createApiClient({ fetch })}
        runs={list}
        botName={botName}
        messageBody={(id) => bodies[id]}
        thread={thread}
        memberCount={1}
        onRunUpdated={onRunUpdated}
      />
    </ol>
  );
}

function setup(
  runs: RunView[],
  routes: RouteTable = {},
  opts: { wrap?: (ui: ReactNode) => ReactNode; thread?: Thread; memberCount?: number } = {},
) {
  const { fetch, calls } = fakeFetch(routes);
  const onRunUpdated = vi.fn();
  const api = createApiClient({ fetch });
  const ui = (list: RunView[]) => {
    const node = (
      <ol>
        <ChatRunStatus
          api={api}
          runs={list}
          botName={botName}
          messageBody={(id) => bodies[id]}
          thread={opts.thread ?? thread}
          memberCount={opts.memberCount ?? 1}
          onRunUpdated={onRunUpdated}
        />
      </ol>
    );
    return opts.wrap ? opts.wrap(node) : node;
  };
  const rendered = render(ui(runs));
  return {
    calls,
    onRunUpdated,
    rerender: (list: RunView[]) => rendered.rerender(ui(list)),
  };
}

/** Open a bot's run list, the only place Stop is offered. */
function expand(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`work items? for ${name}$`) }));
}

const cancelCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/cancel"));

describe("Stop in the grouped run status (issues #76, #126)", () => {
  it("renders nothing when the chat has no unfinished run", () => {
    setup([]);
    expect(screen.queryByTestId("typing")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  it("keeps Stop out of the collapsed summary", () => {
    setup([run({ status: "running" })]);
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expand("ops");
    expect(
      screen.getByRole("button", { name: "Stop ops (working): Reply to “check the deploy”" }),
    ).toBeTruthy();
  });

  it("asks first, explains the scope, then cancels exactly the named run", async () => {
    const active = run({ status: "running" });
    const { calls, onRunUpdated } = setup([active], {
      "POST /api/runs/run_1/cancel": { run: { ...active, status: "cancelled" } },
    });

    expand("ops");
    fireEvent.click(screen.getByRole("button", { name: /^Stop ops \(working\)/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stop ops's work?")).toBeTruthy();
    expect(within(dialog).getByText("run_1")).toBeTruthy();
    expect(dialog.textContent).toContain("Only this work stops");
    expect(dialog.textContent).toContain("other Bots");
    expect(dialog.textContent).toContain("queued");
    expect(cancelCalls(calls)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Stop work" }));
    await screen.findByText("ops's work was cancelled. Other work in this chat keeps going.");
    expect(cancelCalls(calls).map((c) => c.path)).toEqual(["/api/runs/run_1/cancel"]);
    expect(onRunUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });

  it("keeps the run when the operator declines", async () => {
    const { calls } = setup([run({ status: "running" })]);
    expand("ops");
    fireEvent.click(screen.getByRole("button", { name: /^Stop ops \(working\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep working" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancelCalls(calls)).toHaveLength(0);
  });

  it("cancels only the chosen run of the same bot, never the bot's other runs", async () => {
    const a = run({ id: "run_a" as RunId, status: "running" });
    const b = run({
      id: "run_b" as RunId,
      status: "queued",
      triggerRef: "msg_9",
      createdAt: "2026-09-21T10:00:01.000Z",
    });
    const { calls } = setup([a, b], {
      "POST /api/runs/run_b/cancel": { run: { ...b, status: "cancelled" } },
    });
    expand("ops");
    fireEvent.click(
      screen.getByRole("button", { name: "Stop ops (queued): Reply to an earlier message" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("run_b")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop work" }));
    await screen.findByText("ops's work was cancelled. Other work in this chat keeps going.");
    expect(cancelCalls(calls).map((c) => c.path)).toEqual(["/api/runs/run_b/cancel"]);
  });

  it("offers one Stop per run, so cancelling one bot's run leaves the other's", async () => {
    const a = run({ id: "run_a" as RunId, status: "running" });
    const b = run({ id: "run_b" as RunId, botId: "bot_2" as RunView["botId"], status: "queued" });
    const { calls } = setup([a, b], {
      "POST /api/runs/run_b/cancel": { run: { ...b, status: "cancelled" } },
    });
    expand("ops");
    expand("qa");
    expect(screen.getByRole("button", { name: /^Stop ops \(working\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Stop qa \(queued\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop work" }));
    await screen.findByText("qa's work was cancelled. Other work in this chat keeps going.");
    expect(cancelCalls(calls).map((c) => c.path)).toEqual(["/api/runs/run_b/cancel"]);
  });

  it("shows a pending state and sends one request however often Stop is pressed", async () => {
    const active = run({ status: "running" });
    let release: (value: unknown) => void = () => {};
    const { calls } = setup([active], {
      "POST /api/runs/run_1/cancel": () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    expand("ops");
    fireEvent.click(screen.getByRole("button", { name: /^Stop ops \(working\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop work" }));
    const pending = await screen.findByRole("button", { name: "Stopping ops…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(screen.queryByRole("dialog")).toBeNull();
    release({ run: { ...active, status: "cancelled" } });
    await screen.findByText("ops's work was cancelled. Other work in this chat keeps going.");
    expect(cancelCalls(calls)).toHaveLength(1);
  });

  it("reports a run that finished first and refreshes it instead of claiming a cancel", async () => {
    const active = run({ status: "running" });
    const { fetch: base } = fakeFetch({
      "GET /api/runs/run_1": { run: { ...active, status: "succeeded" }, usage: [] },
    });
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? json(409, { code: "invalid_transition", message: "run is terminal", details: {} })
        : base(input, init)) as typeof globalThis.fetch;
    const onRunUpdated = vi.fn();
    render(view(fetch, [active], onRunUpdated));
    expand("ops");
    fireEvent.click(screen.getByRole("button", { name: /^Stop ops \(working\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop work" }));
    await screen.findByText("ops's work had already finished; nothing was cancelled.");
    await waitFor(() =>
      expect(onRunUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" })),
    );
  });

  it.each([
    [403, { code: "forbidden", message: "not your side chat", details: {} }, /cannot cancel/],
    [500, { code: "internal", message: "boom", details: {} }, /Could not cancel ops's work: boom/],
  ])("reports a %s refusal and lets the operator try again", async (status, body, text) => {
    const active = run({ status: "running" });
    const fetch = (async () => json(status, body)) as typeof globalThis.fetch;
    const onRunUpdated = vi.fn();
    render(view(fetch, [active], onRunUpdated));
    expand("ops");
    fireEvent.click(screen.getByRole("button", { name: /^Stop ops \(working\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop work" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(text);
    expect(onRunUpdated).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /^Stop ops \(working\)/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says a network failure may have left the run going", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    render(view(fetch, [run({ status: "running" })]));
    expand("ops");
    fireEvent.click(screen.getByRole("button", { name: /^Stop ops \(working\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop work" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ops's work may still be active",
    );
  });

  it("turns the open confirmation into a notice when the run ends meanwhile", async () => {
    const active = run({ status: "running" });
    const { calls, rerender } = setup([active]);
    expand("ops");
    fireEvent.click(screen.getByRole("button", { name: /^Stop ops \(working\)/ }));
    await screen.findByRole("dialog");
    rerender([]);
    expect(
      await screen.findByText("This work has already finished; there is nothing to stop."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop work" })).toBeNull();
    expect(cancelCalls(calls)).toHaveLength(0);
  });

  it("hides Stop with a role note for a Member outside their own side chat", () => {
    setup(
      [run({ status: "running" })],
      {},
      {
        wrap: (ui) => (
          <SessionRolesProvider roles={MEMBER} actorId="user:u1">
            {ui}
          </SessionRolesProvider>
        ),
      },
    );
    expand("ops");
    expect(screen.getByRole("link", { name: "Work details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(
      screen.getByText(/^Only .+ can cancel a run outside your own side chats\.$/),
    ).toBeTruthy();
  });

  it("offers Stop to a Member in their own side chat", () => {
    setup(
      [run({ status: "running" })],
      {},
      {
        thread: { ...thread, sideChatActor: "user:u1" },
        memberCount: 1,
        wrap: (ui) => (
          <SessionRolesProvider roles={MEMBER} actorId="user:u1">
            {ui}
          </SessionRolesProvider>
        ),
      },
    );
    expand("ops");
    expect(screen.getByRole("button", { name: /^Stop ops \(working\)/ })).toBeTruthy();
  });
});
