// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../../api/client.js";
import {
  FakeEventSource,
  WS_ID,
  browserLock,
  fakeFetch,
  installFakeEventSource,
  workspaceView,
} from "../../test-support/fixtures.js";
import { useWorkspaceLock } from "./use-workspace-lock.js";

function LockHarness({ api }: { api: ApiClient }) {
  const browser = useWorkspaceLock(WS_ID, api);
  return (
    <div>
      <span data-testid="held">{String(browser.held)}</span>
      <span data-testid="screen">{String(browser.hasScreen)}</span>
      <span data-testid="open">{String(browser.screenOpen)}</span>
      <button type="button" onClick={browser.takeOver}>
        Take over
      </button>
      <button type="button" onClick={browser.openScreen}>
        Open screen
      </button>
    </div>
  );
}

describe("useWorkspaceLock", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("takes the lease and opens the screen view; the hold's end closes it (C7)", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces/ws_1": workspaceView(),
      "POST /api/workspaces/ws_1/takeover": { lock: browserLock() },
    });
    render(<LockHarness api={createApiClient({ fetch })} />);
    await waitFor(() => expect(screen.getByTestId("screen").textContent).toBe("true"));
    expect(screen.getByTestId("open").textContent).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("true"));
    // The hook fetches no screen credential: the view asks the proxy for a ticket itself.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/workspaces/ws_1",
      "POST /api/workspaces/ws_1/takeover",
    ]);

    FakeEventSource.last.emit({ type: "workspace_lock", workspaceId: WS_ID, browserLock: null });
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("false"));
    expect(screen.getByTestId("held").textContent).toBe("false");
  });

  it("does not let a stale workspace GET overwrite a later lock frame", async () => {
    let resolve!: (value: ReturnType<typeof workspaceView>) => void;
    const snapshot = new Promise<ReturnType<typeof workspaceView>>((done) => {
      resolve = done;
    });
    const { fetch } = fakeFetch({ "GET /api/workspaces/ws_1": () => snapshot });
    render(<LockHarness api={createApiClient({ fetch })} />);

    FakeEventSource.last.emit({
      type: "workspace_lock",
      workspaceId: WS_ID,
      browserLock: browserLock(),
    });
    resolve(workspaceView({ browserLock: null }));

    await waitFor(() => expect(screen.getByTestId("held").textContent).toBe("true"));
  });

  it("refetches lock state on reconnect and opens the screen only while held", async () => {
    let snapshots = 0;
    const { fetch } = fakeFetch({
      "GET /api/workspaces/ws_1": () =>
        workspaceView({ browserLock: ++snapshots === 1 ? null : browserLock() }),
    });
    render(<LockHarness api={createApiClient({ fetch })} />);
    await waitFor(() => expect(screen.getByTestId("held").textContent).toBe("false"));
    fireEvent.click(screen.getByRole("button", { name: "Open screen" }));
    expect(screen.getByTestId("open").textContent).toBe("false");

    const es = FakeEventSource.last;
    es.open();
    es.drop();
    es.open();
    await waitFor(() => expect(screen.getByTestId("held").textContent).toBe("true"));

    fireEvent.click(screen.getByRole("button", { name: "Open screen" }));
    expect(screen.getByTestId("open").textContent).toBe("true");
    es.emit({ type: "workspace_lock", workspaceId: WS_ID, browserLock: null });
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("false"));
  });
});
