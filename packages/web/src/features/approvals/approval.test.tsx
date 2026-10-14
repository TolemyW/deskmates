// @vitest-environment jsdom
// T1 (in-process): the approval card in the transcript and the approval inbox. The card is drawn
// from the `system` message that carries the approval attachment joined to the `Approval` the
// Gateway returns; a decision goes out as `POST /api/approvals/:id/decide` and comes back either
// as that response or as an `approval` SSE frame, and either way the card stops offering buttons.

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
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
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
        "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [decided] },
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
    const echo = await screen.findByTestId("approval-echo");
    expect(
      within(echo).getByText("Denied by Demo operator: ask human:user:usr_other"),
    ).toBeTruthy();
    expect(within(echo).getByText(body).closest("details")).not.toBeNull();
    expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
    expect(wire.calls.some((call) => /members|people/.test(call.path))).toBe(false);
  });

  it("draws the action from the approval and offers the three decisions", async () => {
    const { fetch } = fakeFetch(threadRoutes());
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const card = await screen.findByTestId("approval-card");
    expect(card.textContent).toContain("browser_click");
    expect(card.textContent).toContain("https://shop.example.com");
    expect(card.textContent).toContain("click Submit order");
    expect(card.textContent).toContain("order the widgets");
    for (const name of ["Allow once", "Always", "Deny"]) {
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
    expect(card.textContent).toContain("browser_click");
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
    expect(within(card).getByRole("button", { name: "Always" })).toBeTruthy();

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

  it("renders the decision echo as a wrapping note with the bot name, not a second card", async () => {
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
        "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [decided] },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    await screen.findByTestId("approval-card");
    expect(screen.getAllByTestId("approval-card")).toHaveLength(1);
    const line = screen.getByTestId("approval-echo");
    expect(line.textContent).toContain("Approved by ops: Critical-path review.");
    expect(line.textContent).not.toContain("bot:bot_1");
    expect(line.querySelector(".approval-decision-text")).toBeTruthy();
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
    const { fetch } = fakeFetch({
      "GET /api/bots": { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: [approval(), other] },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Pending approvals");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("browser_click");
    expect(rows[0]?.textContent).toContain("ops");
    expect(rows[1]?.textContent).toContain("git push origin main");
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("link", { name: "thread" })
        .getAttribute("href"),
    ).toBe(`#/threads/${THREAD_ID}`);
  });

  it("decides a row, drops it, and reports an empty inbox", async () => {
    const decided = approval({
      decision: "allow_always",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    const { fetch, calls } = fakeFetch({
      "GET /api/bots": { bots: [bot] },
      "GET /api/approvals?status=pending": { approvals: [approval()] },
      "POST /api/approvals/apr_1/decide": { approval: decided, rule: approvalRule() },
    });
    render(<ApprovalsScreen api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Pending approvals");
    fireEvent.click(within(list).getByRole("button", { name: "Always" }));
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
    await screen.findByText("browser_click");

    const es = FakeEventSource.last;
    es.open();
    es.drop();
    es.open();
    es.emit({ type: "approval", threadId: THREAD_ID, approval: later });
    resolveReconnect({ approvals: [] });

    await waitFor(() => expect(screen.queryByText("browser_click")).toBeNull());
    expect(await screen.findByText("git push origin main")).toBeTruthy();
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
    expect(card.textContent).toContain("Open docs.databricks.com?");
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
