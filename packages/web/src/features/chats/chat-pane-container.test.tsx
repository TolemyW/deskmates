// @vitest-environment jsdom
// T1 (in-process), issue #15: where the workspace has no container, the composer says what the
// first message does, as the Gateway does it: the run it starts creates the container, and in an
// archived workspace the message is refused. A present container adds no hint.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ThreadScreen } from "./thread.js";

function renderChat(view: Record<string, unknown>, detail: Record<string, unknown> = {}) {
  const { fetch } = fakeFetch({
    "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/bots": { bots: [bot] },
    "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
    "GET /api/threads/thr_1": { thread, members, ...detail },
    "GET /api/workspaces/ws_1": workspaceView(view),
    "GET /api/threads/thr_1/messages": { messages: [] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
  });
  return render(<ThreadScreen threadId={thread.id} api={createApiClient({ fetch })} />);
}

describe("composer container hint (#15)", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("says the first message creates a container that was never created", async () => {
    renderChat({ container: "never_created" });
    const hint = await screen.findByTestId("container-hint");
    expect(hint.textContent).toMatch(/no container yet: your first message creates it/);
  });

  it("says the first message recreates a container removed since the last run", async () => {
    renderChat({ container: "removed" });
    const hint = await screen.findByTestId("container-hint");
    expect(hint.textContent).toMatch(
      /was removed after its last work\. Your first message recreates/,
    );
  });

  it("says a message in an archived workspace is refused", async () => {
    renderChat({}, { workspaceArchived: true });
    const hint = await screen.findByTestId("container-hint");
    expect(hint.textContent).toMatch(/in Trash: a message here is refused and starts nothing/);
  });

  it("adds nothing when the container is present or the Gateway does not say", async () => {
    for (const view of [{ container: "present" }, {}]) {
      renderChat(view);
      await screen.findByLabelText("Message");
      await waitFor(() => expect(screen.queryByTestId("container-hint")).toBeNull());
      cleanup();
    }
  });
});
