// @vitest-environment jsdom
// Issue #11, ADR-0042 decision 2: the runs index composes every filter into one Gateway run-list
// request, shows each run's failure class and mark, opens the drawer from a row, and walks older
// pages with the same filters.

import "@testing-library/jest-dom/vitest";
import type { BotDefinition, BotId, RunId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { bot, run } from "../../test-support/fixtures.js";
import type { RunListFilter, RunPage } from "../runs/api.js";
import { EMPTY_FILTERS, RunIndexScreen, listFilterOf, rowText } from "./run-index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const failed = run({
  id: "run_failed" as RunId,
  status: "failed",
  error: "API Error: 503 No worker available\nsecond line",
  failureClass: "model_unavailable",
  mark: {
    runId: "run_failed" as RunId,
    verdict: "wrong",
    note: "dead cheap model",
    markedBy: "user:usr_1",
    markedAt: "2026-10-14T08:00:00.000Z",
  },
});
const summarized = run({
  id: "run_ok" as RunId,
  status: "succeeded",
  lane: "background",
  activitySummary: {
    runId: "run_ok" as RunId,
    sourceVersion: "a1-succeeded",
    status: "ready",
    text: "Filed the weekly report",
    verbatim: false,
  },
});

function stubApi(pages: RunPage[]) {
  const listRuns = vi.fn(async (_filter?: RunListFilter) => pages.shift() ?? { runs: [] });
  const listBots = vi.fn(async (): Promise<BotDefinition[]> => [bot]);
  const api = { listRuns, listBots } as unknown as ApiClient;
  return { api, listRuns };
}

describe("listFilterOf", () => {
  it("composes every filter, with the end day included", () => {
    const filter = listFilterOf(
      {
        status: "failed",
        botId: "bot_1",
        lane: "background",
        since: "2026-10-01",
        until: "2026-10-07",
        failureClass: "tool_allowlist",
        q: "  exit 2 ",
      },
      undefined,
    );
    expect(filter).toMatchObject({
      status: ["failed"],
      botId: "bot_1",
      lane: "background",
      failureClass: "tool_allowlist",
      q: "exit 2",
      limit: 20,
    });
    expect(filter.since).toBe(new Date("2026-10-01T00:00:00").toISOString());
    expect(filter.until).toBe(new Date("2026-10-08T00:00:00").toISOString());
    expect(listFilterOf(EMPTY_FILTERS, undefined)).toEqual({ limit: 20 });
  });

  it("uses the ready summary as a row's text, else the first line of the error", () => {
    expect(rowText(summarized)).toBe("Filed the weekly report");
    expect(rowText(failed)).toBe("API Error: 503 No worker available");
  });
});

describe("RunIndexScreen", () => {
  it("shows the failure class and the mark, and links each row to the drawer", async () => {
    const { api } = stubApi([{ runs: [failed, summarized] }]);
    render(<RunIndexScreen api={api} />);
    const rows = await screen.findAllByTestId("run-index-row");
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByText("Model unavailable")).toBeInTheDocument();
    expect(within(first).getByTestId("run-mark-badge")).toHaveTextContent("Marked wrong");
    expect(within(first).getByRole("link")).toHaveAttribute("href", "#/runs/run_failed");
    expect(within(rows[1] as HTMLElement).getByText("Filed the weekly report")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByTestId("run-mark-badge")).toBeNull();
  });

  it("refetches the first page with the composed filters as they change", async () => {
    const { api, listRuns } = stubApi([{ runs: [] }, { runs: [] }, { runs: [] }, { runs: [] }]);
    render(<RunIndexScreen api={api} />);
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("Failure class"), {
      target: { value: "egress_blocked" },
    });
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(3));
    fireEvent.change(screen.getByLabelText("Error text"), { target: { value: "allowlist" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(4));
    expect(listRuns.mock.calls.at(-1)?.[0]).toEqual({
      status: ["failed"],
      failureClass: "egress_blocked",
      q: "allowlist",
      limit: 20,
    });
    expect(await screen.findByText("No runs match these filters.")).toBeInTheDocument();
  });

  it("loads older runs with the same filters and the cursor", async () => {
    const { api, listRuns } = stubApi([
      { runs: [failed], nextCursor: "c1" },
      { runs: [summarized] },
    ]);
    render(<RunIndexScreen api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older runs" }));
    await waitFor(() => expect(screen.getAllByTestId("run-index-row")).toHaveLength(2));
    expect(listRuns.mock.calls[1]?.[0]).toEqual({ limit: 20, cursor: "c1" });
    expect(screen.queryByRole("button", { name: "Load older runs" })).toBeNull();
  });

  it("names the workspace's bots in the bot filter", async () => {
    const { api } = stubApi([{ runs: [] }]);
    render(<RunIndexScreen api={api} />);
    const select = screen.getByLabelText("Bot");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: bot.name })).toBeInTheDocument(),
    );
    expect(within(select).getByRole("option", { name: bot.name })).toHaveValue(
      bot.id as BotId as string,
    );
  });
});
