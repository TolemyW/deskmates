// @vitest-environment jsdom
import type { BotId, ThreadId, ThreadMessage } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  FakeEventSource,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";

beforeEach(installFakeEventSource);
afterEach(cleanup);
const longReply = `Opening result.\n${"Supporting calculation with exact evidence. ".repeat(30)}\n[Delivery reference](https://example.test/report)`;
const messages = [
  message(1, "human", "Please review"),
  message(2, "bot", longReply, { mentions: [{ kind: "bot", botId: "bot_2" as BotId }] }),
  message(3, "bot", "Reviewed; one limitation remains.", { authorId: "bot_2" }),
];
function mount(messageId?: string, rows: ThreadMessage[] = messages) {
  const { fetch, calls } = fakeFetch({
    "GET /api/threads/thr_1": {
      thread,
      members: [...members, { ...members[0], botId: "bot_2", name: "reviewer" }],
    },
    "GET /api/threads/thr_1/messages": { messages: rows },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
  });
  render(<ChatPane threadId={THREAD_ID} messageId={messageId} api={createApiClient({ fetch })} />);
  return calls;
}

it("defaults long replies to literal excerpts, retains authors and actual addressing, and keeps drafts untouched", async () => {
  const calls = mount();
  const expand = await screen.findByRole("button", { name: "Read full reply from ops" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: "Delivery reference" })).toBeNull();
  expect(screen.getByText("To reviewer")).toBeTruthy();
  const latest = document.querySelector('li[data-latest="true"]');
  expect(latest?.querySelector(".author")?.textContent).toBe("reviewer");
  const draft = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(draft, { target: { value: "Keep this unsent draft" } });
  fireEvent.click(expand);
  expect(await screen.findByRole("link", { name: "Delivery reference" })).toBeTruthy();
  expect(draft).toHaveProperty("value", "Keep this unsent draft");
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Collapse reply from ops" }));
  expect(screen.queryByRole("link", { name: "Delivery reference" })).toBeNull();
});

it("keeps an explicitly expanded message open on new events and does not label an old reply as the new question's result", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Read full reply from ops" }));
  act(() =>
    FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`).emit({
      type: "thread_message",
      threadId: THREAD_ID as ThreadId,
      message: message(4, "human", "New question"),
    }),
  );
  await waitFor(() => expect(screen.queryByText("Latest reply")).toBeNull());
  expect(screen.getByRole("link", { name: "Delivery reference" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Collapse reply from ops" })).toBeTruthy();
});

it("reveals a deep-linked message without an extra expansion click", async () => {
  mount("msg_2");
  const collapse = await screen.findByRole("button", { name: "Collapse reply from ops" });
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(document.getElementById("message-msg_2") as HTMLElement).getByRole("link", {
      name: "Delivery reference",
    }),
  ).toBeTruthy();
});

it("shows a reasonably sized latest answer in full and keeps it readable when a new question arrives", async () => {
  const answer = Array.from({ length: 12 }, (_, i) => `Result ${i + 1}: verified.`).join("\n");
  mount(undefined, [message(1, "human", "Please review"), message(2, "bot", answer)]);
  await waitFor(() => expect(document.getElementById("message-msg_2")).toBeTruthy());
  // Its 12-line excerpt would hide nothing, so there is nothing to fold (FOLD_MIN_HIDDEN).
  expect(screen.queryByRole("button", { name: "Collapse reply from ops" })).toBeNull();
  expect(document.getElementById("message-msg_2")?.textContent).toContain("Result 12: verified.");
  act(() =>
    FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`).emit({
      type: "thread_message",
      threadId: THREAD_ID as ThreadId,
      message: message(3, "human", "New question"),
    }),
  );
  await waitFor(() => expect(screen.queryByText("Latest reply")).toBeNull());
  expect(document.getElementById("message-msg_2")?.textContent).toContain("Result 12: verified.");
});
