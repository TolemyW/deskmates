// @vitest-environment jsdom
// T1 (in-process): the approval card in the transcript and the approval inbox. The card is drawn
// from the `system` message that carries the approval attachment joined to the `Approval` the
// Gateway returns; a decision goes out as `POST /api/approvals/:id/decide` and comes back either
// as that response or as an `approval` SSE frame, and either way the card stops offering buttons.

import "../../test-support/select.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import {
  type APPROVAL_ID,
  BOT_ID,
  FakeEventSource,
  THREAD_ID,
  approval,
  approvalBody,
  approvalMessage,
  approvalRule,
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ThreadScreen } from "../chats/thread.js";
import { ApprovalCard } from "./approval-card.js";
import { ApprovalsScreen } from "./approvals.js";

const request = approvalMessage(2, approvalBody());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Everything the thread screen fetches before it can draw one thread. */
function threadRoutes(extra: Record<string, unknown> = {}) {
  return {
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/bots": { bots: [bot] },
    "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/threads/thr_1/messages": {
      messages: [message(1, "human", "order the widgets"), request],
    },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [approval()] },
    "GET /api/approvals?threadId=thr_1&ids=apr_1": { approvals: [] },
    ...extra,
  };
}

describe("approval card in the transcript", () => {
  beforeEach(() => {
    installFakeEventSource();
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the authenticated human name while keeping the immutable actor in original details", async () => {
    const decided = approval({ decision: "deny", decidedBy: "human:user:usr_self" });
    render(
      <SessionRolesProvider
        roles={{ tenantRole: "member", platformMaintainer: false }}
        actorId="user:usr_self"
        displayName="Demo operator"
      >
        <ApprovalCard approval={decided} />
      </SessionRolesProvider>,
    );
    expect(screen.getByTestId("approval-decision").textContent).toBe("Denied by Demo operator");
    expect(screen.getByText("human:user:usr_self").closest("details")).not.toBeNull();
    expect(decided.decidedBy).toBe("human:user:usr_self");
  });

  it("resolves only the decision actor in a chat echo and retains the original audit text", async () => {
    const body = "Denied by human:user:usr_self: ask human:user:usr_other";
    const decided = approval({ decision: "deny", decidedBy: "human:user:usr_self" });
    const wire = fakeFetch(
      threadRoutes({
        "GET /api/threads/thr_1/messages": { messages: [request, approvalMessage(3, body)] },
        "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
        "GET /api/approvals?threadId=thr_1&ids=apr_1": { approvals: [decided] },
      }),
    );
    render(
      <SessionRolesProvider
        roles={{ tenantRole: "member", platformMaintainer: false }}
        actorId="user:usr_self"
        displayName="Demo operator"
      >
        <ThreadScreen api={createApiClient({ fetch: wire.fetch })} threadId={THREAD_ID} />
      </SessionRolesProvider>,
    );
    await screen.findByTestId("approval-card");
    const receipt = document.querySelector(".chat-approval-receipt") as HTMLDetailsElement;
    expect(receipt.open).toBe(false);
    expect(receipt.querySelector("summary")?.textContent).toContain("Denied");
    expect(screen.queryByTestId("approval-echo")).toBeNull();
    expect(within(receipt).getByText(body).closest("details")).not.toBeNull();
    expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
    expect(wire.calls.some((call) => /members|people/.test(call.path))).toBe(false);
  });

  it("draws the action from the approval and offers the three decisions", async () => {
    const { fetch } = fakeFetch(threadRoutes());
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const card = await screen.findByTestId("approval-card");
    expect(card.textContent).toContain("Submit order");
    expect(card.textContent).not.toContain("browser_click");
    fireEvent.click(within(card).getByRole("button", { name: "Details" }));
    expect(await screen.findByText("browser_click", { exact: true })).toBeTruthy();
    expect(screen.getByText("https://shop.example.com")).toBeTruthy();
    expect(screen.getByText("click Submit order")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    for (const name of ["Allow once", "More approval options", "Deny"]) {
      expect(within(card).getByRole("button", { name })).toBeTruthy();
    }
    // The raw three-line body is replaced by the card, not printed next to it.
    expect(screen.queryByText(/^Approval needed:/)).toBeNull();
  });

  it("renders an approval card from a legacy attachment in a persisted transcript", async () => {
    const legacyRequest = {
      ...request,
      attachments: [
        { name: "approval", mimeType: "application/vnd.cogbot.approval+json", ref: "apr_1" },
      ],
    };
    const { fetch } = fakeFetch(
      threadRoutes({
        "GET /api/threads/thr_1/messages": {
          messages: [message(1, "human", "order the widgets"), legacyRequest],
        },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const card = await screen.findByTestId("approval-card");
    expect(card.textContent).toContain("Submit order");
    expect(within(card).getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.queryByText(/^Approval needed:/)).toBeNull();
  });

  it("posts {decision: allow_once} and shows the decided state", async () => {
    const decided = approval({
      decision: "allow_once",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    const { fetch, calls } = fakeFetch(
      threadRoutes({ "POST /api/approvals/apr_1/decide": { approval: decided } }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const card = await screen.findByTestId("approval-card");
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));

    await waitFor(() =>
      expect(screen.getByTestId("approval-card").textContent).toContain("Allowed once"),
    );
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/api/approvals/apr_1/decide",
      body: { decision: "allow_once" },
    });
    expect(screen.getByTestId("approval-card").textContent).toContain("human:operator");
    expect(within(screen.getByTestId("approval-card")).queryByRole("button")).toBeNull();
  });

  it("asks for an optional reason before it denies", async () => {
    const denied = approval({
      decision: "deny",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
      reason: "wrong account",
    });
    const { fetch, calls } = fakeFetch(
      threadRoutes({ "POST /api/approvals/apr_1/decide": { approval: denied } }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const card = await screen.findByTestId("approval-card");
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    // Nothing is sent until the deny is confirmed.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(within(card).getByLabelText("Deny reason"), {
      target: { value: "wrong account" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Confirm deny" }));

    await waitFor(() =>
      expect(screen.getByTestId("approval-card").textContent).toContain("Denied"),
    );
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      decision: "deny",
      reason: "wrong account",
    });
  });

  it("flips a pending card to decided when the decision arrives over SSE", async () => {
    const { fetch } = fakeFetch(threadRoutes());
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    const card = await screen.findByTestId("approval-card");
    expect(within(card).getByRole("button", { name: "More approval options" })).toBeTruthy();

    FakeEventSource.forUrl("/api/events?threadId=thr_1").emit({
      type: "approval",
      threadId: THREAD_ID,
      approval: approval({
        decision: "allow_always",
        decidedBy: "bot:bot_1",
        decidedAt: "2026-09-21T10:01:00.000Z",
      }),
    });

    await waitFor(() =>
      expect(screen.getByTestId("approval-card").textContent).toContain("Always allowed"),
    );
    expect(within(screen.getByTestId("approval-card")).queryByRole("button")).toBeNull();
  });

  it("falls back to the message body while the approval has not loaded", async () => {
    const { fetch } = fakeFetch(
      threadRoutes({ "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] } }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("order the widgets");
    const card = await screen.findByTestId("approval-card");
    expect(card.textContent).toContain("Approval needed: browser_click");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("folds the decision echo into the original approval and preserves its audit text", async () => {
    const decided = approval({
      decision: "deny",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    const echo = approvalMessage(
      3,
      `Approved by bot:bot_1: Critical-path review. ${"Verified the evidence before approval. ".repeat(20)}`,
    );
    const { fetch } = fakeFetch(
      threadRoutes({
        "GET /api/threads/thr_1/messages": {
          messages: [message(1, "human", "order the widgets"), request, echo],
        },
        "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
        "GET /api/approvals?threadId=thr_1&ids=apr_1": { approvals: [decided] },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    await screen.findByTestId("approval-card");
    expect(screen.getAllByTestId("approval-card")).toHaveLength(1);
    expect(screen.queryByTestId("approval-echo")).toBeNull();
    const receipt = document.querySelector(".chat-approval-receipt") as HTMLDetailsElement;
    expect(receipt.open).toBe(false);
    expect(receipt.querySelector(".chat-approval-audit")?.textContent).toContain(echo.body);
    fireEvent.click(receipt.querySelector("summary") as HTMLElement);
    expect(receipt.open).toBe(true);
  });
});

describe("ApprovalsScreen", () => {
  beforeEach(() => {
    installFakeEventSource();
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists pending approvals across threads with a link to their thread", async () => {
    const other = approval({
      id: "apr_2" as typeof APPROVAL_ID,
      action: { toolName: "Bash", input: {}, argumentSummary: "git push origin main" },
    });
    const { fetch, calls } = fakeFetch({
      // #113 §3.2: the inbox asks for the bots its page names, never the whole roster.
      [`GET /api/bots?ids=${BOT_ID}`]: { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: [approval(), other] },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Pending approvals");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Submit order");
    await waitFor(() => expect(rows[0]?.textContent).toContain("ops"));
    expect(calls.map((c) => c.path)).not.toContain("/api/bots");
    expect(calls.filter((c) => c.path.startsWith("/api/bots"))).toHaveLength(1);
    expect(rows[1]?.textContent).toContain("git push origin main");
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("link", { name: "chat" })
        .getAttribute("href"),
    ).toBe(`#/threads/${THREAD_ID}`);
  });

  it("shows a retry instead of an empty success state when loading fails", async () => {
    let failed = true;
    const { fetch } = fakeFetch({
      "GET /api/approval-groups": () =>
        failed
          ? new Error("Approval service unavailable")
          : { groups: [], totalGroups: 0, totalApprovals: 0 },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Approval service unavailable",
    );
    expect(screen.queryByText(/Nothing pending/)).toBeNull();
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Nothing pending/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("groups identical actions and decides every request with one group action", async () => {
    const same = approval({
      id: "apr_2" as typeof APPROVAL_ID,
      action: { toolName: "Bash", input: { command: "git push" }, argumentSummary: "git push" },
    });
    let pending = true;
    const { fetch, calls } = fakeFetch({
      [`GET /api/bots?ids=${BOT_ID}`]: { bots: [bot] },
      "GET /api/approval-groups": () =>
        pending
          ? {
              groups: [{ key: "same-action", approval: same, count: 3 }],
              totalGroups: 1,
              totalApprovals: 3,
            }
          : { groups: [], totalGroups: 0, totalApprovals: 0 },
      "POST /api/approval-groups/same-action/decide": () => {
        pending = false;
        return { approvals: [] };
      },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);

    const group = await screen.findByTestId("approval-group");
    expect(group.textContent).toContain("3 identical requests");
    expect(within(group).getByRole("button", { name: "Allow all" })).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Deny all" }));
    await screen.findByText(/Nothing pending/);
    expect(calls.find((call) => call.method === "POST")).toEqual({
      method: "POST",
      path: "/api/approval-groups/same-action/decide",
      body: { decision: "deny_all" },
    });
  });

  it("keeps Tell it what to do on the approval page while denying with new instructions", async () => {
    const denied = approval({
      decision: "deny",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
      reason: "use the preview first",
    });
    const { fetch, calls } = fakeFetch({
      [`GET /api/bots?ids=${BOT_ID}`]: { bots: [bot] },
      "GET /api/approval-groups": {
        groups: [{ key: "one", approval: approval(), count: 1 }],
        totalGroups: 1,
        totalApprovals: 1,
      },
      "POST /api/approvals/apr_1/decide": { approval: denied },
    });
    window.location.hash = "#/approvals";
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);

    const card = await screen.findByTestId("approval-card");
    fireEvent.click(within(card).getByRole("button", { name: "More approval options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Tell it what to do instead" }));
    fireEvent.change(within(card).getByLabelText("Message to the bot"), {
      target: { value: "use the preview first" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Send and let it rethink" }));
    await screen.findByText(/Nothing pending/);
    expect(window.location.hash).toBe("#/approvals");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      decision: "deny",
      reason: "use the preview first",
    });
  });

  it("decides a row, drops it, and reports an empty inbox", async () => {
    const decided = approval({
      decision: "allow_always",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    const { fetch, calls } = fakeFetch({
      [`GET /api/bots?ids=${BOT_ID}`]: { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: [approval()] },
      "POST /api/approvals/apr_1/decide": { approval: decided, rule: approvalRule() },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Pending approvals");
    fireEvent.click(within(list).getByRole("button", { name: "More approval options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Always" }));
    // Always shows the rule's effective scope and decides nothing until it is confirmed.
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
    fireEvent.click(within(list).getByRole("button", { name: "Confirm Always" }));

    await screen.findByText(/Nothing pending/);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ decision: "allow_always" });
    expect(screen.queryByLabelText("Pending approvals")).toBeNull();
  });

  it("reconciles the pending-only snapshot after reconnect without deleting a later SSE row", async () => {
    const later = approval({
      id: "apr_2" as typeof APPROVAL_ID,
      action: { toolName: "Bash", input: {}, argumentSummary: "git push origin main" },
    });
    let resolveReconnect!: (value: { approvals: never[] }) => void;
    const reconnect = new Promise<{ approvals: never[] }>((resolve) => {
      resolveReconnect = resolve;
    });
    let snapshots = 0;
    const { fetch } = fakeFetch({
      "GET /api/bots": { bots: [bot] },
      "GET /api/approvals?status=pending": () =>
        ++snapshots === 1 ? { approvals: [approval()] } : reconnect,
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);
    await screen.findByText(/Click “Submit order”/);

    const es = FakeEventSource.last;
    es.open();
    es.drop();
    es.open();
    es.emit({ type: "approval", threadId: THREAD_ID, approval: later });
    resolveReconnect({ approvals: [] });

    await waitFor(() => expect(screen.queryByText(/Click “Submit order”/)).toBeNull());
    expect(await screen.findByText(/Run “git push origin main”/)).toBeTruthy();
  });

  it("fetches the authoritative decision when a competing decision returns 409", async () => {
    const decided = approval({
      decision: "deny",
      decidedBy: "human:other",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    const base = fakeFetch({
      "GET /api/bots": { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: [approval()] },
      "GET /api/approvals/apr_1": { approval: decided },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST" && url === "/api/approvals/apr_1/decide") {
        return new Response(
          JSON.stringify({
            code: "invalid_transition",
            message: "approval already decided",
            details: {},
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return base.fetch(input, init);
    };
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Pending approvals");
    fireEvent.click(within(list).getByRole("button", { name: "Allow once" }));

    await screen.findByText(/Nothing pending/);
    expect(base.calls.some((call) => call.path === "/api/approvals/apr_1")).toBe(true);
  });

  it("adds a row on a request frame and removes it on a decision frame", async () => {
    const { fetch } = fakeFetch({
      "GET /api/bots": { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: [] },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);
    await screen.findByText(/Nothing pending/);

    const es = FakeEventSource.last;
    expect(es.url).toBe("/api/events");
    es.emit({ type: "approval", threadId: THREAD_ID, approval: approval() });
    const list = await screen.findByLabelText("Pending approvals");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);

    es.emit({
      type: "approval",
      threadId: THREAD_ID,
      approval: approval({
        decision: "deny",
        decidedBy: `human:${BOT_ID}`,
        decidedAt: "2026-09-21T10:01:00.000Z",
      }),
    });
    await screen.findByText(/Nothing pending/);
  });
});

describe("egress approval card (ADR-0020)", () => {
  beforeEach(() => {
    installFakeEventSource();
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("asks to open the site and offers allow-this-site or deny, never allow-once", async () => {
    const ask = approval({
      kind: "egress",
      action: {
        toolName: "mcp__browser__browser_navigate",
        input: { url: "https://docs.databricks.com/guide" },
        targetOrigin: "https://docs.databricks.com",
        argumentSummary: "open https://docs.databricks.com/guide",
      },
    });
    const allowed = { ...ask, decision: "allow_always" as const, decidedBy: "human:operator" };
    const { fetch, calls } = fakeFetch(
      threadRoutes({
        "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [ask] },
        "POST /api/approvals/apr_1/decide": { approval: allowed },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const card = await screen.findByTestId("approval-card");
    expect(card.textContent).toContain("Open docs.databricks.com.");
    expect(within(card).queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Always" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Allow this site" }));
    await waitFor(() =>
      expect(screen.getByTestId("approval-card").textContent).toContain(
        "docs.databricks.com allowed for the workspace",
      ),
    );
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/api/approvals/apr_1/decide",
      body: { decision: "allow_always" },
    });
  });
});

it("retains a failed group decision and lets the operator retry it", async () => {
  const wire = fakeFetch({
    [`GET /api/bots?ids=${BOT_ID}`]: { bots: [bot] },
    "GET /api/approval-groups": {
      groups: [{ key: "retry-group", approval: approval(), count: 2 }],
      totalGroups: 1,
      totalApprovals: 2,
    },
  });
  const api = createApiClient({ fetch: wire.fetch });
  const decide = vi
    .spyOn(api, "decideApprovalGroup")
    .mockRejectedValue(new Error("Group decision failed"));
  render(<ApprovalsScreen api={api} />);
  const group = await screen.findByTestId("approval-group");
  fireEvent.click(within(group).getByRole("button", { name: "Deny all" }));
  expect((await within(group).findByRole("alert")).textContent).toContain("Group decision failed");
  expect(screen.getByTestId("approval-group")).toBeTruthy();
  fireEvent.click(within(group).getByRole("button", { name: "Deny all" }));
  await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  expect(decide.mock.calls).toEqual([
    ["retry-group", "deny_all"],
    ["retry-group", "deny_all"],
  ]);
});

it.each(["member", "admin"] as const)(
  "uses the request workspace's %s role for inbox site approvals",
  async (role) => {
    const requestedWorkspace = "ws_requested" as typeof bot.workspaceId;
    const wire = fakeFetch({
      [`GET /api/bots?ids=${BOT_ID}`]: { bots: [{ ...bot, workspaceId: requestedWorkspace }] },
      "GET /api/approval-groups": {
        groups: [{ key: "site-group", approval: approval({ kind: "egress" }), count: 2 }],
        totalGroups: 1,
        totalApprovals: 2,
      },
    });
    render(
      <SessionRolesProvider
        roles={{
          tenantRole: "owner",
          platformMaintainer: false,
          workspaceRoles: { ws_elsewhere: "owner", [requestedWorkspace]: role },
        }}
      >
        <ApprovalsScreen api={createApiClient({ fetch: wire.fetch })} />
      </SessionRolesProvider>,
    );
    await screen.findByTestId("approval-group");
    await waitFor(() =>
      expect(wire.calls.some((call) => call.path.startsWith("/api/bots?ids="))).toBe(true),
    );
    if (role === "admin") {
      expect(await screen.findByRole("button", { name: "Allow all" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Allow this site" })).toBeTruthy();
    } else {
      expect(screen.queryByRole("button", { name: "Allow all" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Allow this site" })).toBeNull();
      expect(screen.getByRole("button", { name: "Deny all" })).toBeTruthy();
    }
  },
);

it("recovers workspace permissions after a failed bot lookup without deciding an approval", async () => {
  const wire = fakeFetch({
    [`GET /api/bots?ids=${BOT_ID}`]: { bots: [bot] },
    "GET /api/approval-groups": {
      groups: [{ key: "site-retry", approval: approval({ kind: "egress" }), count: 2 }],
      totalGroups: 1,
      totalApprovals: 2,
    },
  });
  const api = createApiClient({ fetch: wire.fetch });
  const lookup = vi.spyOn(api, "listBotsByIds").mockRejectedValueOnce(new Error("Unavailable"));
  const decide = vi.spyOn(api, "decideApprovalGroup");
  render(<ApprovalsScreen api={api} />);
  const retry = await screen.findByRole("button", { name: "Retry workspace lookup" });
  expect(screen.queryByRole("button", { name: "Allow all" })).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByRole("button", { name: "Allow all" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry workspace lookup" })).toBeNull();
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(decide).not.toHaveBeenCalled();
});
