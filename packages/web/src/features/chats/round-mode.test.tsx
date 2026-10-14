// @vitest-environment jsdom
// ADR-0005 amendment 4, decision 29: the per-message 并行 / 依次 toggle under the composer. It
// appears only with @everyone in a group, defaults to parallel, applies to one message and resets.

import type { BotId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { NamedThreadMember } from "../../api/types.js";
import {
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { mentionsEveryone } from "./round-strip.js";

beforeEach(installFakeEventSource);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const group = [
  ...members,
  { ...(members[0] as NamedThreadMember), botId: "bot_2" as BotId, name: "fin" },
];

function setup() {
  return fakeFetch({
    "GET /api/threads/thr_1": { thread, members: group },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/threads/thr_1/messages": { messages: [] },
    "GET /api/threads/thr_1/rounds?limit=20": { rounds: [] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "POST /api/threads/thr_1/messages": {
      message: message(1, "human", "@everyone go"),
      runs: [run()],
    },
  });
}

describe("mentionsEveryone", () => {
  it("matches @everyone as a word only", () => {
    expect(mentionsEveryone("@everyone go")).toBe(true);
    expect(mentionsEveryone("hi @Everyone")).toBe(true);
    expect(mentionsEveryone("mail@everyone.com")).toBe(false);
    expect(mentionsEveryone("@everyones")).toBe(false);
  });
});

describe("the composer round mode", () => {
  it("shows only with @everyone, sends sequential once, then resets to parallel", async () => {
    const { fetch, calls } = setup();
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    const box = await screen.findByLabelText("Message");
    fireEvent.change(box, { target: { value: "plain question" } });
    expect(screen.queryByTestId("round-mode-toggle")).toBeNull();
    fireEvent.change(box, { target: { value: "@everyone go" } });
    const parallel = await screen.findByRole("button", { name: "Parallel" });
    expect(parallel.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "One by one" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      body: "@everyone go",
      roundMode: "sequential",
    });
    fireEvent.change(box, { target: { value: "@everyone again" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Parallel" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("a parallel @everyone sends no mode at all", async () => {
    const { fetch, calls } = setup();
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    const box = await screen.findByLabelText("Message");
    fireEvent.change(box, { target: { value: "@everyone go" } });
    await screen.findByRole("button", { name: "Parallel" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ body: "@everyone go" });
  });
});
