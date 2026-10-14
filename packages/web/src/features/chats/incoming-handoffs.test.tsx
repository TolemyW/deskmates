// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { IncomingHandoff } from "@deskmates/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { parseRoute, threadHref } from "../../router.js";
import {
  FakeEventSource,
  RUN_ID,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
} from "../../test-support/fixtures.js";
import { IncomingHandoffs } from "./incoming-handoffs.js";

beforeEach(installFakeEventSource);
afterEach(cleanup);
const incoming: IncomingHandoff = {
  seq: 1,
  callerName: "databricks_fan",
  excerpt: "@team_chief review the conclusion",
  sourceThreadId: "thr_source" as never,
  sourceMessageId: "msg_source" as never,
  handoffThreadId: "thr_bus" as never,
  runId: RUN_ID,
  status: "queued",
  createdAt: "2026-10-09T09:00:00.000Z",
  unread: true,
};

describe("incoming collaboration reminders", () => {
  it("shows caller, request and exact source link; acknowledges only displayed work and never posts a task", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET /api/threads/${THREAD_ID}/activity`]: { handoffs: [incoming] },
      [`POST /api/threads/${THREAD_ID}/activity/read`]: { ok: true },
    });
    render(
      <ol>
        <IncomingHandoffs api={createApiClient({ fetch })} threadId={THREAD_ID} />
      </ol>,
    );
    await screen.findByText("databricks_fan requested your help");
    expect(screen.getByText(incoming.excerpt)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "View original message" });
    expect(parseRoute(link.getAttribute("href") ?? "")).toEqual({
      name: "threads",
      id: "thr_source",
      messageId: "msg_source",
    });
    expect(screen.getByRole("link", { name: "Open collaboration" })).toHaveAttribute(
      "href",
      threadHref("thr_bus"),
    );
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: `/api/threads/${THREAD_ID}/activity/read`,
      body: { through: 1 },
    });
  });

  it("refreshes the same card on status events and reconnect, without duplicate cards", async () => {
    let handoff = { ...incoming, unread: false };
    const { fetch } = fakeFetch({
      [`GET /api/threads/${THREAD_ID}/activity`]: () => ({ handoffs: [handoff] }),
    });
    render(
      <ol>
        <IncomingHandoffs api={createApiClient({ fetch })} threadId={THREAD_ID} />
      </ol>,
    );
    await screen.findByText("queued");
    handoff = { ...handoff, status: "succeeded" };
    act(() => {
      FakeEventSource.instances.at(-1)?.emit({ type: "thread_activity", threadId: THREAD_ID });
    });
    await screen.findByText("Completed");
    handoff = { ...handoff, status: "failed" };
    act(() => {
      const stream = FakeEventSource.last;
      stream.open();
      stream.drop();
      stream.open();
    });
    await screen.findByText("failed");
    expect(screen.getAllByText("databricks_fan requested your help")).toHaveLength(1);
  });
});
