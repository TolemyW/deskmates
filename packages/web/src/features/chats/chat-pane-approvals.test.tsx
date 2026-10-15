// @vitest-environment jsdom
// T0 web for #113 surface 26: the chat asks for the approvals its loaded messages name, plus the
// thread's pending ones, never the thread's whole decided history. Load older asks for the
// approvals of the older window only.

import "@testing-library/jest-dom/vitest";
import type { ApprovalId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  type RouteTable,
  THREAD_ID,
  approval,
  approvalBody,
  approvalMessage,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";

const newer = approval({
  id: "apr_new" as ApprovalId,
  decision: "deny",
  decidedBy: "human:operator",
});
const older = approval({
  id: "apr_old" as ApprovalId,
  decision: "allow_once",
  decidedBy: "human:operator",
});

function routes(extra: RouteTable = {}): RouteTable {
  return {
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": {
      messages: [
        approvalMessage(51, approvalBody(newer), newer.id),
        message(52, "human", "newest window ends here"),
      ],
      hasOlder: true,
    },
    "GET /api/threads/thr_1/messages?beforeSeq=51": {
      messages: [approvalMessage(1, approvalBody(older), older.id)],
      hasOlder: false,
    },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?threadId=thr_1&ids=apr_new": { approvals: [newer] },
    "GET /api/approvals?threadId=thr_1&ids=apr_old": { approvals: [older] },
    "GET /api/workspaces/ws_1": workspaceView(),
    ...extra,
  };
}

describe("chat approvals bounded to the loaded messages (#113 surface 26)", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => cleanup());

  it("asks only for the approvals the loaded window names, then the older window's on request", async () => {
    const { fetch, calls } = fakeFetch(routes());
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("newest window ends here");
    await waitFor(() => expect(screen.getAllByTestId("approval-decision")).toHaveLength(1));
    const approvalCalls = () =>
      calls.map((c) => c.path).filter((path) => path.startsWith("/api/approvals"));
    expect(approvalCalls()).not.toContain("/api/approvals?status=decided&threadId=thr_1");
    expect(approvalCalls()).toContain("/api/approvals?threadId=thr_1&ids=apr_new");
    expect(approvalCalls()).not.toContain("/api/approvals?threadId=thr_1&ids=apr_old");

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(screen.getAllByTestId("approval-decision")).toHaveLength(2));
    expect(approvalCalls()).toContain("/api/approvals?threadId=thr_1&ids=apr_old");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("asks for no decided approvals when the window names none", async () => {
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "just words")] },
      }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("just words");
    await waitFor(() =>
      expect(calls.map((c) => c.path)).toContain("/api/approvals?status=pending&threadId=thr_1"),
    );
    expect(calls.filter((c) => c.path.startsWith("/api/approvals"))).toHaveLength(1);
  });

  it("splits a window naming more than 100 approvals into requests of 100", async () => {
    const many = Array.from({ length: 101 }, (_, i) =>
      approvalMessage(i + 1, "Approval needed", `apr_${String(i).padStart(3, "0")}` as ApprovalId),
    );
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1/messages": { messages: [...many, message(102, "human", "done")] },
      }),
    );
    // Every id request answers empty; only the request shape matters here.
    const batches: string[][] = [];
    const wrapped: typeof fetch = async (input, init) => {
      const url = String(input);
      const prefix = "/api/approvals?threadId=thr_1&ids=";
      if (url.startsWith(prefix)) {
        batches.push(decodeURIComponent(url.slice(prefix.length)).split(","));
        return new Response(JSON.stringify({ approvals: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(input, init);
    };
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch: wrapped })} />);
    await screen.findByText("done");
    await waitFor(() => expect(batches).toHaveLength(2));
    expect(batches.map((ids) => ids.length)).toEqual([100, 1]);
    expect(new Set(batches.flat()).size).toBe(101);
    expect(calls.map((c) => c.path)).toContain("/api/approvals?status=pending&threadId=thr_1");
  });
});
