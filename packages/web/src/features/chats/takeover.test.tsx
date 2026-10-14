// @vitest-environment jsdom
// T1 (in-process): the takeover controls in the chat header. The pane reads the thread's
// workspace, offers "Take over" while nobody holds the browser, opens the shared screen through
// the Gateway's screen proxy on a takeover (never a noVNC address or password; ADR-0022
// amendment 1, C7), says so while a human holds it, hands back, and follows the
// `workspace_lock` frame so a second operator tab agrees without a refetch (ADR-0004, design
// v0.3 §3.3).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { rfbOpenings } from "../../test-support/fake-rfb.js";
import {
  FakeEventSource,
  type RouteTable,
  THREAD_ID,
  WS_ID,
  browserLock,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  screenTicket,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";

vi.mock("@novnc/novnc", async () => ({
  default: (await import("../../test-support/fake-rfb.js")).FakeRfb,
}));

const transcript = [message(1, "human", "check the console")];

/** Everything the pane fetches for one thread, plus whatever the test overrides. */
function routes(extra: RouteTable = {}): RouteTable {
  return {
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": { messages: transcript },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
    "POST /api/workspaces/ws_1/takeover/open-screen": screenTicket({ protocol: "ticket-1" }),
    "POST /api/screen-access/acc_1/close": { closed: true },
    ...extra,
  };
}

describe("takeover controls", () => {
  beforeEach(() => {
    installFakeEventSource();
    rfbOpenings.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offers Take over while nobody holds the browser", async () => {
    const { fetch } = fakeFetch(routes());
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    await screen.findByRole("button", { name: "Take over" });
    expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
    expect(screen.queryByText(/a human holds the browser/)).toBeNull();
  });

  it("takes the lease, then streams the shared screen through the proxy with no password", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { fetch, calls } = fakeFetch(
      routes({ "POST /api/workspaces/ws_1/takeover": { lock: browserLock() } }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));

    await screen.findByRole("dialog", { name: "Shared workspace screen" });
    await waitFor(() => expect(rfbOpenings).toHaveLength(1));
    const [opening] = rfbOpenings;
    expect(opening?.url).toBe(`ws://${window.location.host}/api/desktop-stream`);
    expect(opening?.options).toEqual({ wsProtocols: ["ticket-1"] });
    expect(opening?.viewOnly).toBe(false);
    expect(open).not.toHaveBeenCalled();
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain("POST /api/workspaces/ws_1/takeover");
    expect(paths).toContain("POST /api/workspaces/ws_1/takeover/open-screen");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("shows the no-screen note and opens nothing when the container has not started", async () => {
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/workspaces/ws_1": workspaceView({ takeoverScreen: false }),
        "POST /api/workspaces/ws_1/takeover": { lock: browserLock() },
      }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));

    await screen.findByText("no screen yet (the workspace container has not started)");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.map((c) => c.path)).not.toContain("/api/workspaces/ws_1/takeover/open-screen");
    expect(rfbOpenings).toHaveLength(0);
  });

  it("reopens the screen of a hold found on load with a fresh proxy ticket", async () => {
    const { fetch, calls } = fakeFetch(
      routes({ "GET /api/workspaces/ws_1": workspaceView({ browserLock: browserLock() }) }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const openButton = await screen.findByRole("button", { name: "Open screen" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(openButton);

    await screen.findByRole("dialog", { name: "Shared workspace screen" });
    await waitFor(() => expect(rfbOpenings).toHaveLength(1));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "POST /api/workspaces/ws_1/takeover/open-screen",
    );
  });

  it("drops the screen the moment the hold ends elsewhere", async () => {
    const { fetch } = fakeFetch(
      routes({ "POST /api/workspaces/ws_1/takeover": { lock: browserLock() } }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    await waitFor(() => expect(rfbOpenings).toHaveLength(1));

    FakeEventSource.forUrl("/api/events").emit({
      type: "workspace_lock",
      workspaceId: WS_ID,
      browserLock: null,
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rfbOpenings[0]?.disconnected).toBe(true);
  });

  it("hands the browser back", async () => {
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/workspaces/ws_1": workspaceView({ browserLock: browserLock() }),
        "POST /api/workspaces/ws_1/handback": { released: true },
      }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Hand back" }));

    await screen.findByRole("button", { name: "Take over" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
      "POST /api/workspaces/ws_1/handback",
    );
  });

  it("follows the workspace_lock frame from the unfiltered stream in both directions", async () => {
    const { fetch } = fakeFetch(routes());
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByRole("button", { name: "Take over" });

    // The frame carries no threadId, so it only arrives on the pane's second, unfiltered stream.
    const es = FakeEventSource.forUrl("/api/events");
    es.emit({ type: "workspace_lock", workspaceId: WS_ID, browserLock: browserLock() });
    await screen.findByRole("button", { name: "Hand back" });

    // Another tab hands back: this one follows without a refetch.
    es.emit({ type: "workspace_lock", workspaceId: WS_ID, browserLock: null });
    await screen.findByRole("button", { name: "Take over" });
    await waitFor(() => expect(screen.queryByText(/a human holds the browser/)).toBeNull());
  });
});
