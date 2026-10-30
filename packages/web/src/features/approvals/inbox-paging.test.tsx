// @vitest-environment jsdom
// T0, #113 surface 23: the Attention inbox pages by the Gateway's cursor, shows the server total,
// steps back from a page its decisions emptied, and never inserts a live row into a page when
// there are more pages; the nav badge is the server total, not the length of one page.

import type { ApprovalId } from "@deskmates/contracts";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { STUB_CONTEXT } from "../../app/testing/feature-expectations.js";
import {
  FakeEventSource,
  THREAD_ID,
  approval,
  bot,
  fakeFetch,
  installFakeEventSource,
} from "../../test-support/fixtures.js";
import { ApprovalsScreen } from "./approvals.js";
import { feature } from "./feature.js";

const row = (n: number) =>
  approval({
    id: `apr_${String(n).padStart(2, "0")}` as ApprovalId,
    createdAt: `2026-10-14T00:00:${String(n).padStart(2, "0")}.000Z`,
    action: { toolName: "Bash", input: {}, argumentSummary: `command ${n}` },
  });
const first = Array.from({ length: 25 }, (_, i) => row(i));
const second = [row(25), row(26)];

beforeEach(() => {
  installFakeEventSource();
  window.location.hash = "";
});
afterEach(cleanup);

describe("Attention inbox pages (#113 surface 23)", () => {
  it("pages forward and back with the server total, and never inserts a live row mid-list", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/bots": { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: first, nextCursor: "c1", total: 27 },
      "GET /api/approvals?status=pending&cursor=c1": { approvals: second, total: 27 },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);
    const list = await screen.findByLabelText("Pending approvals");
    expect(within(list).getAllByRole("listitem")).toHaveLength(25);
    const pages = screen.getByRole("navigation", { name: "Approval pages" });
    expect(pages.textContent).toContain("1–25 of 27");

    // A new request while there are more pages: no new row here; the page is asked for again.
    FakeEventSource.last.emit({ type: "approval", threadId: THREAD_ID, approval: row(40) });
    expect(within(list).getAllByRole("listitem")).toHaveLength(25);
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/approvals?status=pending").length).toBe(2),
    );

    fireEvent.click(within(pages).getByRole("button", { name: /Next/ }));
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Pending approvals")).getAllByRole("listitem"),
      ).toHaveLength(2),
    );
    expect(screen.getByRole("navigation", { name: "Approval pages" }).textContent).toContain(
      "26–27 of 27",
    );
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Approval pages" })).getByRole("button", {
        name: /Previous/,
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Pending approvals")).getAllByRole("listitem"),
      ).toHaveLength(25),
    );
  });

  it("steps back to the previous page when decisions empty the last one", async () => {
    let secondPage = second;
    const { fetch } = fakeFetch({
      "GET /api/bots": { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: first, nextCursor: "c1", total: 27 },
      "GET /api/approvals?status=pending&cursor=c1": () => ({ approvals: secondPage, total: 27 }),
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);
    await screen.findByLabelText("Pending approvals");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Run “command 26”.");
    secondPage = [];
    for (const decided of second)
      FakeEventSource.last.emit({
        type: "approval",
        threadId: THREAD_ID,
        approval: {
          ...decided,
          decision: "deny",
          decidedBy: "human:web",
          decidedAt: "2026-10-14T01:00:00.000Z",
        },
      });
    await screen.findByText("Run “command 0”.");
  });
});

describe("Attention badge", () => {
  it("counts the server total, not one page", async () => {
    const { fetch } = fakeFetch({
      "GET /api/approvals?status=pending": { approvals: first, nextCursor: "c1", total: 27 },
    });
    const ctx = { ...STUB_CONTEXT, api: createApiClient({ fetch }) };
    const { result } = renderHook(() => feature.nav?.badge?.useCount(ctx));
    await waitFor(() => expect(result.current).toBe(27));
  });
});

it("ignores a stale reconnect response after a newer inbox snapshot", async () => {
  let finishOld: (value: {
    groups: { key: string; approval: ReturnType<typeof row>; count: number }[];
    totalGroups: number;
    totalApprovals: number;
  }) => void = () => {};
  const old = new Promise((resolve) => {
    finishOld = resolve;
  });
  let reads = 0;
  const full = {
    groups: [{ key: "old-request", approval: row(1), count: 1 }],
    totalGroups: 1,
    totalApprovals: 1,
  };
  const wire = fakeFetch({
    "GET /api/approval-groups": () =>
      ++reads === 1 ? full : reads === 2 ? old : { groups: [], totalGroups: 0, totalApprovals: 0 },
  });
  render(<ApprovalsScreen api={createApiClient({ fetch: wire.fetch })} />);
  await screen.findByText(/command 1/);
  const es = FakeEventSource.last;
  es.open();
  es.drop();
  es.open();
  await waitFor(() => expect(reads).toBe(2));
  es.drop();
  es.open();
  await screen.findByText(/Nothing pending/);
  finishOld(full);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/command 1/)).toBeNull();
  expect(screen.getByText(/Nothing pending/)).toBeTruthy();
});
