// @vitest-environment jsdom
// T1 (in-process): the run screen shows the header and per-model usage ("unpriced" for a null
// cost), renders events in seq order with the right treatment per kind, appends events and status
// changes live from SSE, refetching usage once the run ends, subscribes before it fetches and
// recovers what a stream gap swallowed, and never loads a screenshot from another origin.

import type { RunId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  FakeEventSource,
  RUN_ID,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  run,
  runEvent,
  usage,
} from "../../test-support/fixtures.js";
import { RunEventRow, screenshotSource } from "./run-event-row.js";
import { RunScreen } from "./run.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const events = [
  runEvent(4, "screenshot", { dataUrl: PNG, caption: "console" }),
  runEvent(1, "thinking", { text: "let me look" }),
  runEvent(3, "tool_result", { toolUseId: "tu_1", content: "ok", isError: false }),
  runEvent(2, "tool_call", { toolUseId: "tu_1", toolName: "browser_navigate", riskLevel: "L0" }),
  runEvent(5, "approval", { phase: "decided", toolName: "browser_click", decision: "deny" }),
  runEvent(6, "takeover", { toolName: "browser_click", waitMessage: "human holds the browser" }),
  runEvent(7, "cap_breached", { cap: "turn_budget" }),
  runEvent(8, "pricing_missing", { model: "some-model" }),
  runEvent(9, "log", { source: "assistant", text: "all green" }),
];

// File-level, not per-describe: the `screenshotSource` render test mounts a full `RunScreen` too,
// so it needs the fake EventSource and leaves a DOM behind. Scoped to one describe, both depended
// on test order and broke under `--sequence.shuffle` (issue #68).
beforeEach(() => {
  installFakeEventSource();
});
afterEach(() => {
  cleanup();
});

describe("RunScreen", () => {
  it.each([false, true])(
    "shows partial counters and explicit uncertain attribution (%s)",
    async (attributionUncertain) => {
      const { fetch } = fakeFetch({
        "GET /api/runs/run_1": {
          run: run({ status: attributionUncertain ? "succeeded" : "cancelled" }),
          usageCoverage: "partial",
          usage: [
            {
              ...usage("measured", null),
              inputTokens: 300,
              outputTokens: null,
              coverage: "partial",
              attributionUncertain,
            },
          ],
        },
        "GET /api/runs/run_1/events": { events: [] },
      });
      render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
      await screen.findByText("Partial measured usage; totals are lower bounds");
      if (attributionUncertain)
        expect(
          screen.getByText("Includes session usage with uncertain run attribution."),
        ).toBeTruthy();
      expect(screen.getByText("300")).toBeTruthy();
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    },
  );

  it("renders the header, unpriced usage, and events in seq order", async () => {
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": {
        run: run({
          status: "succeeded",
          startedAt: "2026-09-21T10:00:01.000Z",
          finishedAt: "2026-09-21T10:00:04.500Z",
          summary: {
            done: "checked",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
            reply: "all green",
          },
        }),
        usage: [usage("priced-model", 0.0123), usage("free-model", null)],
      },
      "GET /api/runs/run_1/events": { events },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Run events");
    // Issue #9: the tool call and its result are one row.
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(8));
    const descending = within(list).getAllByRole("listitem");
    const sequences = descending.map((row) =>
      Number(row.querySelector(".seq")?.textContent?.slice(1)),
    );
    expect(sequences).toEqual([...sequences].sort((a, b) => b - a));
    fireEvent.click(screen.getByRole("button", { name: "Show oldest first" }));
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".seq")?.textContent)).toEqual([
      "#1",
      "#2",
      "#4",
      "#5",
      "#6",
      "#7",
      "#8",
      "#9",
    ]);
    expect(rows.map((r) => r.querySelector(".kind")?.textContent)).toEqual([
      "thinking",
      "tool_call",
      "screenshot",
      "approval",
      "takeover",
      "cap_breached",
      "pricing_missing",
      "log",
    ]);

    fireEvent.click(screen.getByText("Details and usage"));
    // Header facts.
    expect(screen.getByText("succeeded").className).toContain("status");
    expect(screen.getByText("interactive")).toBeTruthy();
    expect(screen.getByText("thread_message")).toBeTruthy();
    expect(screen.getByRole("link", { name: THREAD_ID }).getAttribute("href")).toBe(
      `#/threads/${THREAD_ID}`,
    );
    expect(screen.getByText("(3.5 s)")).toBeTruthy();

    // Usage: priced and unpriced rows.
    const table = screen.getByRole("table");
    const cells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      );
    expect(cells).toEqual([
      ["priced-model", "100", "20", "0", "0", "$0.0123"],
      ["free-model", "100", "20", "0", "0", "unpriced"],
    ]);

    // Thinking is collapsed; tool call and result expand to JSON; screenshot is an <img>.
    const thinking = rows[0]?.querySelector("details");
    expect(thinking?.open).toBe(false);
    expect(thinking?.textContent).toContain("let me look");
    expect(rows[1]?.querySelector(".event-summary")?.textContent).toBe(
      "browser_navigate · L0 · 0 ms",
    );
    expect([...(rows[1]?.querySelectorAll("details") ?? [])].map((d) => d.open)).toEqual([
      false,
      false,
    ]);
    expect(rows[1]?.textContent).toContain("result (#3)");
    expect(rows[2]?.querySelector("img")?.getAttribute("src")).toBe(PNG);
    expect(rows[2]?.textContent).toContain("console");
    expect(rows[3]?.textContent).toContain("decided · browser_click · deny");
    // A takeover that parked a browser call shows the wait message the hook returned.
    expect(rows[4]?.textContent).toContain("human holds the browser");
    expect(rows[5]?.textContent).toContain("turn_budget");
    expect(rows[6]?.textContent).toContain("some-model has no price");
    expect(rows[7]?.textContent).toContain("all green");
  });

  it("labels a takeover ledger event with its phase", async () => {
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "running" }), usage: [] },
      "GET /api/runs/run_1/events": {
        events: [
          runEvent(1, "takeover", { phase: "taken", by: "human:operator" }),
          runEvent(2, "takeover", { phase: "handed_back", by: "human:operator" }),
        ],
      },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Run events");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    const rows = within(list).getAllByRole("listitem");
    expect(rows[1]?.querySelector(".event-summary")?.textContent).toBe("taken");
    expect(rows[0]?.querySelector(".event-summary")?.textContent).toBe("handed_back");
  });

  it("explains a no_reply failure instead of printing the bare reason", async () => {
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": {
        run: run({ status: "failed", error: "no_reply", config: { mustReply: true } }),
        usage: [],
      },
      "GET /api/runs/run_1/events": { events: [] },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
    const notice = await screen.findByText(/^No reply/);
    expect(notice.className).toContain("danger");
    expect(notice.textContent).toContain("must-reply message");
    expect(notice.textContent).toContain("no_reply");
  });

  it("explains a deadline cancellation", async () => {
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "cancelled", error: "deadline" }), usage: [] },
      "GET /api/runs/run_1/events": { events: [] },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
    const notice = await screen.findByText(/^Deadline passed/);
    expect(notice.textContent).toContain("(deadline)");
  });

  it("hides diagnostic log rows by default and reveals every raw event on request", async () => {
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "succeeded" }), usage: [] },
      "GET /api/runs/run_1/events": {
        events: [
          runEvent(1, "log", { source: "phase_timing", phase: "model_request", edge: "start" }),
          runEvent(2, "log", { source: "assistant", text: "finished" }),
          runEvent(3, "log", { source: "phase_timing", phase: "model_request", edge: "end" }),
          runEvent(4, "log", { source: "resource_observation", version: 1, memoryMb: 512 }),
          runEvent(5, "log", { source: "sidecar", level: "error", error: "boom" }),
          runEvent(6, "log", { source: "stall", op: "stalled", idleMs: 300000, stallSeconds: 300 }),
        ],
      },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Run events");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(screen.getByText("(3 visible of 6 total)")).toBeTruthy();
    expect(within(list).getByText("no progress for 5 min 0 s: marked stalled")).toBeTruthy();
    const toggle = screen.getByRole("checkbox", { name: "Show diagnostic log rows (3)" });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("(6)")).toBeTruthy();
  });

  it("appends events live from SSE and refetches usage when the run ends", async () => {
    let getRunCalls = 0;
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": () => {
        getRunCalls += 1;
        return getRunCalls === 1
          ? { run: run({ status: "running" }), usage: [] }
          : { run: run({ status: "succeeded" }), usage: [usage("m", null)] };
      },
      "GET /api/runs/run_1/events": { events: [runEvent(1, "log", { text: "start" })] },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("start");
    expect(screen.getByText("running").className).toContain("status");
    expect(screen.getByText(/No usage recorded yet/)).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.last.url).toBe(`/api/events?threadId=${THREAD_ID}`));

    const es = FakeEventSource.last;
    es.emit({
      type: "run_event",
      threadId: THREAD_ID,
      event: runEvent(3, "log", { text: "third" }),
    });
    es.emit({
      type: "run_event",
      threadId: THREAD_ID,
      event: runEvent(2, "tool_call", { toolName: "browser_snapshot" }),
    });
    // Frames for another run are ignored.
    es.emit({
      type: "run_event",
      threadId: THREAD_ID,
      event: { ...runEvent(99, "log", { text: "other" }), runId: "run_other" as typeof RUN_ID },
    });
    await screen.findByText("third");
    const list = screen.getByLabelText("Run events");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((r) => r.querySelector(".seq")?.textContent),
    ).toEqual(["#3", "#2", "#1"]);
    expect(screen.queryByText("other")).toBeNull();

    es.emit({ type: "run_status", threadId: THREAD_ID, run: run({ status: "succeeded" }) });
    await screen.findByText("succeeded");
    await screen.findByText("unpriced");
    expect(getRunCalls).toBe(2);
  });

  it("subscribes before the first fetch, so a status change in that window survives", async () => {
    // Whether the stream exists is recorded when the fetch fires, and the response is held back,
    // so the ordering is measured rather than assumed from React having flushed its effects.
    let subscribedAtFetch: boolean | undefined;
    let releaseRun: (value: unknown) => void = () => {};
    const { fetch } = fakeFetch({
      // Only the first call is measured: after the SSE status ends the run, the usage refresh
      // calls `getRun` again, when the subscription exists anyway.
      "GET /api/runs/run_1": () => {
        if (subscribedAtFetch === undefined)
          subscribedAtFetch = FakeEventSource.instances.length > 0;
        return new Promise((resolve) => {
          releaseRun = resolve;
        });
      },
      "GET /api/runs/run_1/events": { events: [runEvent(1, "log", { text: "start" })] },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);

    // The stream is open while `getRun` is held in flight. It cannot be thread-scoped yet: the
    // run's thread is what `getRun` is being asked for.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.last.url).toBe("/api/events");
    FakeEventSource.last.emit({
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "succeeded", finishedAt: "2026-09-21T10:00:05.000Z" }),
    });
    // Always the pre-change row: the response left the Gateway before the run finished.
    releaseRun({ run: run({ status: "running" }), usage: [] });

    await screen.findByText("start");
    expect(subscribedAtFetch).toBe(true);
    // The status that arrived first is kept; the stale row does not roll it back to running.
    expect(screen.getByText("succeeded").className).toContain("status");
    expect(screen.queryByText("running")).toBeNull();
    // Once the thread is known the stream narrows to it.
    expect(FakeEventSource.last.url).toBe(`/api/events?threadId=${THREAD_ID}`);
  });

  it("refetches the run and the events it missed after a stream gap", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "running" }), usage: [] },
      "GET /api/runs/run_1/events": { events: [runEvent(1, "log", { text: "start" })] },
      // The recovery asks only for what the screen does not already hold.
      "GET /api/runs/run_1/events?afterSeq=1": {
        events: [runEvent(2, "log", { text: "missed while down" })],
      },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("start");

    // The browser drops the stream and gets it back. Frames sent meanwhile are never replayed.
    // The stream is opened by an effect React may flush after the fetch answered, so wait for it.
    const es = await waitFor(() => FakeEventSource.last);
    es.drop();
    es.open();

    await screen.findByText("missed while down");
    expect(calls.map((c) => c.path)).toContain("/api/runs/run_1/events?afterSeq=1");
    const list = screen.getByLabelText("Run events");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((r) => r.querySelector(".seq")?.textContent),
    ).toEqual(["#2", "#1"]);
  });

  it("keeps terminal usage when the initial running snapshot arrives late", async () => {
    let releaseFirst: (value: unknown) => void = () => {};
    let reads = 0;
    const completed = run({ status: "succeeded", finishedAt: "2026-09-21T10:00:05.000Z" });
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": () => {
        if (++reads === 1)
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        return { run: completed, usage: [usage("late-priced-model", 0.0123)] };
      },
      "GET /api/runs/run_1/events": {
        events: [runEvent(1, "log", { text: "initial snapshot event" })],
      },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
    // The frame lands while the first fetch is held; the stream is opened by an effect React
    // flushes on its own schedule, so wait for it.
    const es = await waitFor(() => FakeEventSource.last);
    es.emit({ type: "run_status", threadId: THREAD_ID, run: completed });
    await screen.findByText("late-priced-model");
    releaseFirst({ run: run({ status: "running" }), usage: [] });
    await screen.findByText("initial snapshot event");
    expect(screen.getByText("succeeded").className).toContain("status");
    expect(screen.getByText("late-priced-model")).toBeTruthy();
    expect(screen.queryByText("No usage recorded.")).toBeNull();
  });

  it("clears run A immediately when the route changes to run B", async () => {
    const secondId = "run_2" as RunId;
    let resolveFirst: ((value: unknown) => void) | undefined;
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      "GET /api/runs/run_1/events": { events: [runEvent(1, "log", { text: "from A" })] },
      "GET /api/runs/run_2": {
        run: run({ id: secondId, status: "failed", error: "B failed" }),
        usage: [],
      },
      "GET /api/runs/run_2/events": {
        events: [{ ...runEvent(1, "log", { text: "from B" }), runId: secondId }],
      },
    });
    const api = createApiClient({ fetch });
    const view = render(<RunScreen runId={RUN_ID} api={api} />);

    expect(screen.getByText(RUN_ID)).toBeTruthy();
    view.rerender(<RunScreen runId={secondId} api={api} />);
    expect(screen.queryByText("from A")).toBeNull();
    expect(screen.getByText(secondId)).toBeTruthy();
    await screen.findByText("from B");
    expect(screen.getByText("B failed")).toBeTruthy();

    resolveFirst?.({ run: run({ status: "succeeded" }), usage: [] });
    await Promise.resolve();
    expect(screen.queryByText("from A")).toBeNull();
    expect(screen.getByText(secondId)).toBeTruthy();
  });

  it("cancels a live run from the header and shows the cancelled status", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "running" }), usage: [] },
      "GET /api/runs/run_1/events": { events: [] },
      "POST /api/runs/run_1/cancel": { run: run({ status: "cancelled" }) },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
    const cancel = await screen.findByRole("button", { name: "Cancel run" });
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(document.querySelector(".run-title .status")?.textContent).toBe("cancelled"),
    );
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/runs/run_1/cancel")).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("offers no cancel for a finished run, and shows a refused cancel as an error", async () => {
    const finished = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "succeeded" }), usage: [] },
      "GET /api/runs/run_1/events": { events: [] },
    });
    const { unmount } = render(
      <RunScreen runId={RUN_ID} api={createApiClient({ fetch: finished.fetch })} />,
    );
    await screen.findByLabelText("Run events");
    await waitFor(() =>
      expect(document.querySelector(".run-title .status")?.textContent).toBe("succeeded"),
    );
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    unmount();

    const refused = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "waiting_approval" }), usage: [] },
      "GET /api/runs/run_1/events": { events: [] },
      "POST /api/runs/run_1/cancel": () => new Error("run run_1 is already succeeded"),
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch: refused.fetch })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText(/already succeeded/)).toBeTruthy();
  });
});

describe("screenshotSource", () => {
  it("handles data URLs, same-origin paths, raw base64 and bare paths", () => {
    expect(screenshotSource({ dataUrl: PNG })).toEqual({ src: PNG });
    expect(screenshotSource({ ref: "/api/artifacts/1.png" })).toEqual({
      src: "/api/artifacts/1.png",
    });
    expect(screenshotSource({ base64: "AAAA", mimeType: "image/jpeg" })).toEqual({
      src: "data:image/jpeg;base64,AAAA",
    });
    expect(screenshotSource({ path: "/home/ops/shot.png" })).toEqual({
      text: "/home/ops/shot.png",
    });
    expect(screenshotSource({})).toEqual({});
  });

  it("never turns an off-origin or non-image reference into an <img> source", () => {
    // The UI talks only to the Gateway; an absolute URL in a run payload is agent-influenced and
    // loading it would be a tracking pixel fired from the operator's browser.
    for (const url of [
      "https://tracker.example/pixel.png?run=run_1",
      "http://tracker.example/pixel.png",
      "//tracker.example/pixel.png",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:application/octet-stream;base64,AAAA",
      "/assets/not-api.png",
    ]) {
      expect(screenshotSource({ url })).toEqual({ text: url });
    }
    // Every key the row looks at is filtered the same way.
    for (const key of ["dataUrl", "data_url", "src", "image", "ref", "path", "file"]) {
      expect(screenshotSource({ [key]: "https://tracker.example/pixel.png" })).toEqual({
        text: "https://tracker.example/pixel.png",
      });
    }
  });

  it("only interpolates a mimeType that is an image type into the data URL", () => {
    expect(screenshotSource({ base64: "AAAA", mimeType: "image/svg+xml" })).toEqual({
      src: "data:image/svg+xml;base64,AAAA",
    });
    // A payload must not choose how the bytes are parsed, nor add URL syntax of its own.
    for (const mimeType of [
      "text/html",
      "image/png;base64,PHN2Zz48L3N2Zz4=,",
      "image/png,<script>",
      "image/png ",
      "",
      42,
    ]) {
      expect(screenshotSource({ base64: "AAAA", mimeType })).toEqual({
        src: "data:image/png;base64,AAAA",
      });
    }
  });

  it("renders an off-origin screenshot reference as text, not an image", async () => {
    const { fetch } = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "succeeded" }), usage: [] },
      "GET /api/runs/run_1/events": {
        events: [runEvent(1, "screenshot", { url: "https://tracker.example/pixel.png" })],
      },
    });
    render(<RunScreen runId={RUN_ID} api={createApiClient({ fetch })} />);
    const list = await screen.findByLabelText("Run events");
    await within(list).findByText("https://tracker.example/pixel.png");
    expect(list.querySelector("img")).toBeNull();
  });
});

describe("browser evidence download links", () => {
  it("links only bounded cache paths through the supplied authenticated workspace route", () => {
    const path = "/work/browser-evidence/12345678-1234-1234-1234-123456789abc.txt";
    const event = runEvent(1, "tool_result", {
      content: "canary",
      truncated: true,
      evidence: { path },
    });
    render(
      <ol>
        <RunEventRow
          event={event}
          evidenceUrl={(p) => `/api/workspaces/ws_1/files?path=${encodeURIComponent(p)}`}
        />
      </ol>,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      `/api/workspaces/ws_1/files?path=${encodeURIComponent(path)}`,
    );
  });
  it.each([
    "https://outside.test/secret",
    "/profile/Cookies",
    "/work/browser-evidence/../secret.txt",
  ])("never links an untrusted artifact path %s", (path) => {
    render(
      <ol>
        <RunEventRow
          event={runEvent(1, "tool_result", { evidence: { path } })}
          evidenceUrl={(p) => p}
        />
      </ol>,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});
