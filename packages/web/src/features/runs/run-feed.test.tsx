// @vitest-environment jsdom
// T0 web for #113 slice R: a run feed loads the first page (live runs plus the newest finished
// ones), appends older pages with the Gateway's cursor, resets when its scope changes, drops a
// response for an earlier scope that arrives late, and merges a live run without moving the
// loaded pages. The run replay opens on the newest events and loads older ones on request.

import "@testing-library/jest-dom/vitest";
import type { BotId, RunId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { createApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import {
  FakeEventSource,
  fakeFetch,
  installFakeEventSource,
  run,
  runEvent,
} from "../../test-support/fixtures.js";
import { type RunFeedScope, useRunFeed } from "./run-feed.js";
import { RunScreen } from "./run.js";

function Feed({ api, scope }: { api: ApiClient; scope: RunFeedScope }) {
  const feed = useRunFeed(api, scope);
  return (
    <div>
      {feed.loading ? <output>Loading feed</output> : null}
      {feed.error ? <p role="alert">{feed.error}</p> : null}
      <button type="button" onClick={() => void feed.reload()}>
        reload
      </button>
      <ul>
        {[...feed.runs]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((r) => (
            <li key={r.id}>{`${r.id}:${r.status}`}</li>
          ))}
      </ul>
      {feed.hasOlder ? (
        <button type="button" onClick={() => void feed.loadOlder()}>
          older
        </button>
      ) : null}
    </div>
  );
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString();
const r = (id: string, minute: number, extra: Partial<RunView> = {}) =>
  run({ id: id as RunId, createdAt: at(minute), status: "succeeded", ...extra });
const BOT_A = "bot_a" as BotId;
const BOT_B = "bot_b" as BotId;

describe("run feed (#113 R)", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => cleanup());

  it("recovers a failed first page with its older-page cursor", async () => {
    const listRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce({ runs: [r("recovered", 8)], nextCursor: "older-cursor" })
      .mockResolvedValueOnce({ runs: [r("older", 1)] });
    render(<Feed api={{ listRuns } as unknown as ApiClient} scope={{ botId: BOT_A }} />);
    expect(screen.getByText("Loading feed")).toBeInTheDocument();
    await screen.findByRole("alert");
    expect(screen.queryByText("Loading feed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await screen.findByText("recovered:succeeded");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "older" }));
    await screen.findByText("older:succeeded");
    expect(listRuns).toHaveBeenLastCalledWith({ botId: BOT_A, cursor: "older-cursor" });
  });

  it("appends older pages by cursor and merges a live run on top", async () => {
    const listRuns = vi.fn(async (filter: { cursor?: string }) =>
      filter.cursor === "c2"
        ? { runs: [r("run_old", 1)] }
        : { runs: [r("run_live", 9, { status: "running" }), r("run_new", 8)], nextCursor: "c2" },
    );
    render(<Feed api={{ listRuns } as unknown as ApiClient} scope={{ botId: BOT_A }} />);
    await screen.findByText("run_new:succeeded");
    expect(listRuns).toHaveBeenCalledWith({ botId: BOT_A });
    fireEvent.click(screen.getByRole("button", { name: "older" }));
    await screen.findByText("run_old:succeeded");
    expect(listRuns).toHaveBeenLastCalledWith({ botId: BOT_A, cursor: "c2" });
    expect(screen.queryByRole("button", { name: "older" })).toBeNull();
    act(() =>
      FakeEventSource.last.emit({
        type: "run_status",
        run: r("run_live", 9, { botId: BOT_A, status: "failed" }),
      }),
    );
    await screen.findByText("run_live:failed");
    // The older page stays loaded; the live frame changed one row, not the pages.
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "run_live:failed",
      "run_new:succeeded",
      "run_old:succeeded",
    ]);
  });

  it("resets on a scope change and ignores a late response for the previous scope", async () => {
    let finishA!: (page: { runs: RunView[] }) => void;
    const listRuns = vi.fn((filter: { botId?: BotId }) =>
      filter.botId === BOT_A
        ? new Promise<{ runs: RunView[] }>((resolve) => {
            finishA = resolve;
          })
        : Promise.resolve({ runs: [r("run_b", 5, { botId: BOT_B })] }),
    );
    const api = { listRuns } as unknown as ApiClient;
    const view = render(<Feed api={api} scope={{ botId: BOT_A }} />);
    view.rerender(<Feed api={api} scope={{ botId: BOT_B }} />);
    await screen.findByText("run_b:succeeded");
    await act(async () => finishA({ runs: [r("run_a", 6, { botId: BOT_A })] }));
    expect(screen.queryByText("run_a:succeeded")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("run replay events (#113 R)", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => cleanup());

  it("opens on the newest events and loads older ones before them", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/runs/run_1": { run: run({ status: "succeeded" }), usage: [] },
      "GET /api/runs/run_1/events": {
        events: [runEvent(201, "log", { line: "newest window" })],
        hasOlder: true,
      },
      "GET /api/runs/run_1/events?beforeSeq=201": {
        events: [runEvent(1, "log", { line: "first event" })],
        hasOlder: false,
      },
    });
    render(<RunScreen runId={"run_1" as RunId} api={createApiClient({ fetch })} />);
    const older = await screen.findByRole("button", { name: "Load older events" });
    fireEvent.click(older);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull(),
    );
    expect(calls.map((c) => c.path)).toContain("/api/runs/run_1/events?beforeSeq=201");
    expect(screen.getByRole("list", { name: /events/i }).children).toHaveLength(2);
  });
});
