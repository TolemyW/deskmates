// @vitest-environment jsdom
// T1 (in-process): ADR-0014 amendment A3 in the chat pane. Workspace paths in human and bot
// messages are download buttons; a click starts a same-origin attachment download so the browser
// can stream up to the 1 GiB bound without buffering the file in a page-owned Blob.

import { RUN_ERROR_GATEWAY_RESTARTED } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  type RouteTable,
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

const transcript = [
  message(1, "human", "please put it in /work/in.md，thanks"),
  message(2, "bot", "Done: /home/ops/out.csv.\nAlso see work/relative.md"),
  message(3, "system", "system note about /work/system.md"),
];

function routes(extra: RouteTable = {}): RouteTable {
  return {
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": { messages: transcript },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
    ...extra,
  };
}

const FILES_PREFIX = "/api/workspaces/ws_1/files?path=";

/** The route table for JSON, plus the binary file route with its request headers recorded. */
function fetchWithFiles(file: () => Response): {
  fetch: typeof globalThis.fetch;
  fileRequests: Array<{ url: string; headers: Headers }>;
} {
  const json = fakeFetch(routes());
  const fileRequests: Array<{ url: string; headers: Headers }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(FILES_PREFIX)) {
      fileRequests.push({ url, headers: new Headers(init?.headers) });
      return file();
    }
    return json.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, fileRequests };
}

describe("workspace path links in the transcript", () => {
  let clicked: HTMLAnchorElement[];
  beforeEach(() => {
    installFakeEventSource();
    clicked = [];
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:fake/download"),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("links paths in human and bot messages only, with the punctuation left as text", async () => {
    const { fetch } = fetchWithFiles(() => new Response("x"));
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const human = await screen.findByRole("button", { name: "Preview of /work/in.md" });
    expect(human.getAttribute("title")).toBe("/work/in.md");
    expect(human.closest(".body")?.textContent).toContain("in.md，thanks");
    const bot = screen.getByRole("button", { name: "Preview of /home/ops/out.csv" });
    expect(bot.getAttribute("title")).toBe("/home/ops/out.csv");
    expect(screen.queryByRole("button", { name: "work/relative.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: "/work/system.md" })).toBeNull();
    expect(screen.getByText("system note about /work/system.md")).toBeTruthy();
  });

  it("streams through a same-origin attachment download and never navigates", async () => {
    const { fetch, fileRequests } = fetchWithFiles(
      () => new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    const before = window.location.href;

    fireEvent.click(await screen.findByRole("button", { name: "Preview of /home/ops/out.csv" }));
    const download = await screen.findByRole("button", { name: "Download /home/ops/out.csv" });
    const requestsBeforeDownload = fileRequests.length;
    fireEvent.click(download);

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(fileRequests).toHaveLength(requestsBeforeDownload);
    expect(clicked[0]?.download).toBe("out.csv");
    expect(clicked[0]?.getAttribute("href")).toBe(
      `${FILES_PREFIX}${encodeURIComponent("/home/ops/out.csv")}`,
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });

  it("uses the same streaming download for a human-authored path", async () => {
    const { fetch, fileRequests } = fetchWithFiles(() => new Response("not fetched"));
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Preview of /work/in.md" }));
    const download = await screen.findByRole("button", { name: "Download /work/in.md" });
    const requestsBeforeDownload = fileRequests.length;
    fireEvent.click(download);

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(fileRequests).toHaveLength(requestsBeforeDownload);
    expect(clicked[0]?.download).toBe("in.md");
    expect(clicked[0]?.getAttribute("href")).toBe(
      `${FILES_PREFIX}${encodeURIComponent("/work/in.md")}`,
    );
  });
});

describe("a failed run's outcome row (#63 M14)", () => {
  afterEach(cleanup);

  it("says what a recorded reason means instead of showing its code", async () => {
    installFakeEventSource();
    const { fetch } = fakeFetch(
      routes({
        "GET /api/runs?threadId=thr_1": {
          runs: [run({ status: "failed", error: RUN_ERROR_GATEWAY_RESTARTED })],
        },
      }),
    );
    const { container } = render(
      <ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />,
    );
    expect(
      await screen.findByText(/The server restarted before the work could continue/),
    ).toBeTruthy();
    expect(container.querySelector(".run-outcome")?.textContent).not.toContain(
      RUN_ERROR_GATEWAY_RESTARTED,
    );
  });
});

describe("deleted conversation", () => {
  it("shows a terminal 404 state with no composer or retry", async () => {
    installFakeEventSource();
    const { fetch } = fakeFetch({});
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    expect((await screen.findByTestId("deleted-object")).textContent).toContain(
      "This item is no longer available",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

describe("Stop in an open chat (issue #76)", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offers Stop for the chat's active run and drops it once the run is cancelled", async () => {
    const active = run({ status: "running" });
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/runs?threadId=thr_1": { runs: [active] },
        "POST /api/runs/run_1/cancel": { run: { ...active, status: "cancelled" } },
      }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    fireEvent.click(await screen.findByRole("button", { name: "1 work item for ops" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Stop ops \(working\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop work" }));

    await screen.findByText("ops's work was cancelled. Other work in this chat keeps going.");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/api/runs/run_1/cancel",
    ]);
    expect(screen.queryByRole("button", { name: /^Stop ops/ })).toBeNull();
    expect(screen.queryByTestId("typing")).toBeNull();
  });

  it("offers no Stop when nothing is running", async () => {
    const { fetch } = fakeFetch(routes());
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByRole("button", { name: "Preview of /work/in.md" });
    expect(screen.queryByTestId("typing")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });
});
