// @vitest-environment jsdom
// T1 (in-process): issue #76. The chat offers one Stop per unfinished run of this chat, names the
// bot and status of the run it targets, asks before cancelling and says what is and is not
// stopped. It uses the existing `POST /api/runs/:id/cancel`; the Gateway decides permission.

import type { RunId, SessionRoles, Thread } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { type RouteTable, fakeFetch, run, thread } from "../../test-support/fixtures.js";
import { ChatRunStop } from "./chat-run-stop.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const names: Record<string, string> = { bot_1: "ops", bot_2: "qa" };
const botName = (id: string) => names[id] ?? id;
const MEMBER: SessionRoles = { tenantRole: "member", platformMaintainer: false };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
      <ChatRunStop
        api={api}
        runs={list}
        botName={botName}
        thread={opts.thread ?? thread}
        memberCount={opts.memberCount ?? 1}
        onRunUpdated={onRunUpdated}
      />
    );
    return opts.wrap ? opts.wrap(node) : node;
  };
  const view = render(ui(runs));
  return {
    calls,
    onRunUpdated,
    rerender: (list: RunView[]) => view.rerender(ui(list)),
  };
}

const cancelCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/cancel"));

describe("ChatRunStop (issue #76)", () => {
  it("renders nothing when the chat has no unfinished run", () => {
    setup([]);
    expect(screen.queryByRole("group", { name: "Stop work in this chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  it("asks first, explains the scope, then cancels exactly the named run", async () => {
    const active = run({ status: "running" });
    const { calls, onRunUpdated } = setup([active], {
      "POST /api/runs/run_1/cancel": { run: { ...active, status: "cancelled" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop ops (running)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stop this run of ops?")).toBeTruthy();
    expect(within(dialog).getByText("run_1")).toBeTruthy();
    expect(dialog.textContent).toContain("Only this run stops");
    expect(dialog.textContent).toContain("other bots");
    expect(dialog.textContent).toContain("queued");
    expect(cancelCalls(calls)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Stop run" }));
    await screen.findByText("ops's run was cancelled. Other work in this chat keeps going.");
    expect(cancelCalls(calls).map((c) => c.path)).toEqual(["/api/runs/run_1/cancel"]);
    expect(onRunUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });

  it("keeps the run when the operator declines", async () => {
    const { calls } = setup([run({ status: "running" })]);
    fireEvent.click(screen.getByRole("button", { name: "Stop ops (running)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep running" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancelCalls(calls)).toHaveLength(0);
  });

  it("offers one Stop per run, so cancelling one bot's run leaves the other's", async () => {
    const a = run({ id: "run_a" as RunId, status: "running" });
    const b = run({ id: "run_b" as RunId, botId: "bot_2" as RunView["botId"], status: "queued" });
    const { calls } = setup([a, b], {
      "POST /api/runs/run_b/cancel": { run: { ...b, status: "cancelled" } },
    });
    expect(screen.getByRole("button", { name: "Stop ops (running)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop qa (queued)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    await screen.findByText("qa's run was cancelled. Other work in this chat keeps going.");
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
    fireEvent.click(screen.getByRole("button", { name: "Stop ops (running)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    const pending = await screen.findByRole("button", { name: "Stopping ops…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(screen.queryByRole("dialog")).toBeNull();
    release({ run: { ...active, status: "cancelled" } });
    await screen.findByText("ops's run was cancelled. Other work in this chat keeps going.");
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
    render(
      <ChatRunStop
        api={createApiClient({ fetch })}
        runs={[active]}
        botName={botName}
        thread={thread}
        memberCount={1}
        onRunUpdated={onRunUpdated}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop ops (running)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    await screen.findByText("ops's run had already finished; nothing was cancelled.");
    await waitFor(() =>
      expect(onRunUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" })),
    );
  });

  it.each([
    [403, { code: "forbidden", message: "not your side chat", details: {} }, /permission/],
    [500, { code: "internal", message: "boom", details: {} }, /Could not cancel ops's run: boom/],
  ])("reports a %s refusal and lets the operator try again", async (status, body, text) => {
    const active = run({ status: "running" });
    const fetch = (async () => json(status, body)) as typeof globalThis.fetch;
    const onRunUpdated = vi.fn();
    render(
      <ChatRunStop
        api={createApiClient({ fetch })}
        runs={[active]}
        botName={botName}
        thread={thread}
        memberCount={1}
        onRunUpdated={onRunUpdated}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop ops (running)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(text);
    expect(onRunUpdated).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Stop ops (running)" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says a network failure may have left the run going", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    render(
      <ChatRunStop
        api={createApiClient({ fetch })}
        runs={[run({ status: "running" })]}
        botName={botName}
        thread={thread}
        memberCount={1}
        onRunUpdated={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop ops (running)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ops's run may still be running",
    );
  });

  it("turns the open confirmation into a notice when the run ends meanwhile", async () => {
    const active = run({ status: "running" });
    const { calls, rerender } = setup([active]);
    fireEvent.click(screen.getByRole("button", { name: "Stop ops (running)" }));
    await screen.findByRole("dialog");
    rerender([]);
    expect(
      await screen.findByText("This run has already finished; there is nothing to stop."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Stop ops (running)" })).toBeTruthy();
  });
});
