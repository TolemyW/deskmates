// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://192.168.1.20:8081/"}
// T1 (in-process): the chat header's takeover controls on a page opened over the LAN. The
// workspace's noVNC is published on the Gateway host's loopback, which a colleague's browser
// cannot reach. Since ADR-0022 amendment 1 (C7) the takeover screen never uses that address: it
// streams through the Gateway's `/api/desktop-stream` proxy, so it works from any machine that
// reaches the Gateway, and no loopback address or password reaches the page.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { rfbOpenings } from "../../test-support/fake-rfb.js";
import {
  type RouteTable,
  THREAD_ID,
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

function routes(extra: RouteTable = {}): RouteTable {
  return {
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "check the console")] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
    "POST /api/workspaces/ws_1/takeover/open-screen": screenTicket(),
    "POST /api/screen-access/acc_1/close": { closed: true },
    ...extra,
  };
}

describe("takeover controls on a LAN origin", () => {
  beforeEach(() => {
    installFakeEventSource();
    rfbOpenings.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("streams the shared screen through the Gateway it was loaded from, never a loopback page", async () => {
    expect(window.location.hostname).toBe("192.168.1.20");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { fetch } = fakeFetch(
      routes({ "POST /api/workspaces/ws_1/takeover": { lock: browserLock() } }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));

    await waitFor(() => expect(rfbOpenings).toHaveLength(1));
    expect(rfbOpenings[0]?.url).toBe("ws://192.168.1.20:8081/api/desktop-stream");
    expect(JSON.stringify(rfbOpenings[0]?.options)).not.toMatch(/password|127\.0\.0\.1/);
    expect(open).not.toHaveBeenCalled();
    for (const link of screen.queryAllByRole("link"))
      expect(link.getAttribute("href") ?? "").not.toMatch(/127\.0\.0\.1|password=/);
  });
});
