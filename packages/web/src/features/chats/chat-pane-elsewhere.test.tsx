// @vitest-environment jsdom
// A one-member chat shows its bot's work elsewhere in the transcript at the time it ended, so a
// task finished before today's question sits above it, and work in progress below the newest
// message (chat feedback update of 2026-10-11, revised 2026-10-17).

import type { RunId, ThreadId } from "@deskmates/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
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

const at = (hhmm: string) => `2026-09-29T${hhmm}:00.000Z`;
const other = { threadId: "thr_other" as ThreadId };

beforeEach(() => installFakeEventSource());
afterEach(() => cleanup());

it("places a finished run from elsewhere before the messages that came after it, and live work last", async () => {
  const { fetch } = fakeFetch({
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/threads/thr_1/messages": {
      messages: [
        message(1, "human", "yesterday's ask", { ts: at("07:00") }),
        message(2, "human", "today's ask", { ts: at("09:00") }),
        message(3, "bot", "today's answer", { ts: at("09:01") }),
      ],
    },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/runs?botId=bot_1": {
      runs: [
        run({
          id: "run_task" as RunId,
          ...other,
          status: "succeeded",
          createdAt: at("07:30"),
          finishedAt: at("08:00"),
          activitySummary: {
            runId: "run_task" as RunId,
            sourceVersion: "a1-succeeded",
            status: "ready",
            text: "Report delivered",
            verbatim: true,
          },
        }),
        run({ id: "run_live" as RunId, ...other, status: "running", createdAt: at("08:30") }),
      ],
    },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
  });
  render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
  const delivered = await screen.findByText("Report delivered");
  const rows = screen.getAllByTestId("elsewhere-activity");
  expect(rows).toHaveLength(2);
  const before = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const msg = (id: string) => document.getElementById(`message-${id}`) as HTMLElement;
  expect(before(msg("msg_1"), delivered)).toBe(true);
  expect(before(delivered, msg("msg_2"))).toBe(true);
  const live = rows.find((row) => row.textContent?.includes("working")) as HTMLElement;
  expect(before(msg("msg_3"), live)).toBe(true);
  expect(rows[0]?.textContent).toContain("A message in another chat");
  expect(screen.getAllByRole("link", { name: "Open chat" })[0]?.getAttribute("href")).toBe(
    "#/threads/thr_other",
  );
  // The section that used to pin every card under the newest message is gone.
  expect(screen.queryByText(/Activity in other chats/)).toBeNull();
});
