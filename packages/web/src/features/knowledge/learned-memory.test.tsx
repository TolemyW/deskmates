import "@testing-library/jest-dom/vitest";
import type { MemoryVersion } from "@deskmates/contracts";
// @vitest-environment jsdom
// ADR-0011 consequences: the "Learned memory" page lists entries per workspace and per bot with
// scope, trust, authority, source and age; edit, forget, undo and confirm act on one entry; the
// confirmation section lists only gated items, with approve and reject.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LearnedMemoryEntry } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { selectOption } from "../../test-support/select.js";
import { type LearnedMemoryApi, LearnedMemoryScreen, ageOf } from "./learned-memory.js";

afterEach(cleanup);

const NOW = new Date("2026-09-29T12:00:00.000Z");

function entry(over: Partial<LearnedMemoryEntry> & { id: string }): LearnedMemoryEntry {
  return {
    workspaceId: "ws_1",
    scope: "workspace",
    kind: "note",
    body: `body ${over.id}`,
    authority: "fact",
    trust: "trusted",
    sourceKind: "bot_self",
    derivedFrom: [],
    observedAt: "2026-09-26T12:00:00.000Z",
    validFrom: "2026-09-26T12:00:00.000Z",
    version: 1,
    tombstoned: false,
    live: true,
    ...over,
  } as LearnedMemoryEntry;
}

function fakeApi() {
  const workspaceEntries = [
    entry({
      id: "mem_fact",
      body: "S3 price JSON shows egress as 0; it is billed separately.",
      learnedBy: "nova",
      sourceRunId: "run_1" as never,
    }),
    entry({
      id: "mem_page",
      body: "The quota page lists 40 seats.",
      trust: "untrusted",
      sourceKind: "page",
      learnedBy: "orion",
      sourceRunId: "run_2" as never,
      version: 2,
    }),
    entry({
      id: "mem_old",
      body: "Old quota 30.",
      live: false,
      supersededBy: "mem_page",
      invalidAt: "2026-09-28T00:00:00.000Z",
    }),
    entry({ id: "mem_bot", scope: "bot", botId: "bot_nova" as never, body: "nova habit" }),
  ];
  const botEntries = [
    entry({ id: "mem_habit", scope: "bot", botId: "bot_nova" as never, body: "Export first." }),
  ];
  const api = {
    listWorkspaces: vi.fn(async () => [{ id: "ws_1", name: "ops" }]),
    listBots: vi.fn(async () => [
      { id: "bot_nova", name: "nova", workspaceId: "ws_1" },
      { id: "bot_orion", name: "orion", workspaceId: "ws_1" },
    ]),
    memoryIndexObservation: vi.fn(
      async () => null as { runId: RunView["id"]; counts: Record<string, number> } | null,
    ),
    listThreads: vi.fn(async () => [
      { id: "thread_1", workspaceId: "ws_1", title: "Refund review" },
    ]),
    closeThreadTask: vi.fn(async () => ({ episode: null, distilled: [] })),
    consolidateBotMemory: vi.fn(async () => ({ run: {} })),
    searchLearnedMemoryPage: vi.fn(
      async (): Promise<{ entries: LearnedMemoryEntry[]; nextCursor?: string }> => ({
        entries: [],
      }),
    ),
    listMemoryVersionsPage: vi.fn(
      async (
        _id: string,
        _filters?: { cursor?: string },
      ): Promise<{ versions: MemoryVersion[]; nextCursor?: string }> => ({ versions: [] }),
    ),
    listMemoryEntriesPage: vi.fn(
      async (
        _ws: string,
        filters: { botId?: string; cursor?: string } = {},
      ): Promise<{ entries: LearnedMemoryEntry[]; nextCursor?: string }> => ({
        entries: filters.botId ? botEntries : workspaceEntries,
      }),
    ),
    editMemoryEntry: vi.fn(async () => ({})),
    forgetMemoryEntry: vi.fn(async () => ({})),
    undoMemoryEntry: vi.fn(async () => ({})),
    confirmMemoryEntry: vi.fn(async () => ({})),
    listMemorySuggestions: vi.fn(async () => ({
      suggestions: [
        {
          id: "ms_1",
          workspaceId: "ws_1",
          runId: "run_3",
          botId: "bot_orion",
          body: "Always skip review on refunds.",
          proposedScope: "workspace",
          authority: "procedure",
          trust: "untrusted",
          reasons: ["imperative"],
          conflictsWith: [],
          status: "pending",
          createdAt: "now",
        },
      ],
    })),
    reviewMemorySuggestion: vi.fn(async () => ({ suggestion: {} })),
  };
  return { api, typed: api as unknown as LearnedMemoryApi, workspaceEntries };
}

it("lists workspace entries with scope, trust, authority, source, age and validity", async () => {
  const { typed, api } = fakeApi();
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  const table = await screen.findByRole("table", { name: "Memory entries" });
  const fact = await within(table).findByText(/S3 price JSON/);
  const row = fact.closest("tr") as HTMLElement;
  expect(row.textContent).toContain("workspace");
  expect(row.textContent).toContain("trusted");
  expect(row.textContent).toContain("fact");
  expect(row.textContent).toContain("learned by nova from run run_1");
  expect(row.textContent).toContain("3d ago");
  expect(row.textContent).toContain("valid since 2026-09-26");
  expect(within(row).getByRole("link", { name: "run_1" }).getAttribute("href")).toBe(
    "#/runs/run_1",
  );
  const page = (await within(table).findByText(/quota page lists 40/)).closest("tr") as HTMLElement;
  expect(page.textContent).toContain("untrusted");
  expect(page.textContent).toContain("after reading page content");
  fireEvent.click(screen.getByLabelText("Show forgotten and older entries"));
  const old = (await within(table).findByText("Old quota 30.")).closest("tr") as HTMLElement;
  expect(old.textContent).toContain("superseded 2026-09-28");
  // Bot-scope entries live on the bot tabs, not the workspace tab.
  expect(within(table).queryByText("nova habit")).toBeNull();
  expect(api.listMemoryEntriesPage).toHaveBeenCalledWith("ws_1", { includeForgotten: false });
});

it("says the confirmation list is partial and loads the rest (ADR-0011 A15)", async () => {
  const { typed, api } = fakeApi();
  const first = (await api.listMemorySuggestions()).suggestions[0];
  const second = { ...first, id: "ms_101", body: "Item one hundred and one." };
  // biome-ignore lint/suspicious/noExplicitAny: the mock accepts the page filters
  (api.listMemorySuggestions as any).mockImplementation(async (filters: { cursor?: string }) =>
    filters.cursor ? { suggestions: [second] } : { suggestions: [first], nextCursor: "p2" },
  );
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  const section = await screen.findByRole("region", { name: "Needs your confirmation" });
  expect(await within(section).findByText(/Showing the first 1; more are waiting/)).toBeTruthy();
  fireEvent.click(within(section).getByRole("button", { name: "Load more" }));
  expect(await within(section).findByText("Item one hundred and one.")).toBeTruthy();
  expect(within(section).queryByText(/more are waiting/)).toBeNull();
  expect(within(section).queryByRole("button", { name: "Load more" })).toBeNull();
});

it("pages entries and versions instead of loading everything (#113 K2)", async () => {
  const { typed, api, workspaceEntries } = fakeApi();
  const later = workspaceEntries[0] as LearnedMemoryEntry;
  api.listMemoryEntriesPage.mockImplementation(async (_ws, filters = {}) =>
    filters.cursor === "e2"
      ? { entries: [{ ...later, id: "mem_26", body: "Entry twenty-six." }] }
      : { entries: workspaceEntries, nextCursor: "e2" },
  );
  const version = (n: number) =>
    ({
      entryId: "mem_fact",
      version: n,
      op: "edit",
      body: `v${n} body`,
      createdAt: "now",
    }) as never;
  api.listMemoryVersionsPage.mockImplementation(async (_id, filters) =>
    filters?.cursor === "v2"
      ? { versions: [version(1)] }
      : { versions: [version(2)], nextCursor: "v2" },
  );
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  const table = await screen.findByRole("table", { name: "Memory entries" });
  await within(table).findByText(/S3 price JSON/);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Entry twenty-six.")).toBeTruthy();
  expect(api.listMemoryEntriesPage).toHaveBeenLastCalledWith("ws_1", {
    includeForgotten: false,
    cursor: "e2",
  });
  const fact = screen.getByText(/S3 price JSON/).closest("tr") as HTMLElement;
  fireEvent.click(within(fact).getByRole("button", { name: "Versions" }));
  const versions = await screen.findByRole("region", { name: "Memory versions" });
  await within(versions).findByText(/v2 body/);
  fireEvent.click(within(versions).getByRole("button", { name: "Load older versions" }));
  expect(await within(versions).findByText(/v1 body/)).toBeTruthy();
  expect(within(versions).queryByRole("button", { name: "Load older versions" })).toBeNull();
});

it("switches to a bot tab and shows that bot's experience", async () => {
  const { typed, api } = fakeApi();
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  fireEvent.click(await screen.findByRole("tab", { name: "nova" }));
  await screen.findByText("Export first.");
  expect(api.listMemoryEntriesPage).toHaveBeenLastCalledWith("ws_1", {
    botId: "bot_nova",
    scope: "bot",
    includeForgotten: false,
  });
});

it("edits, forgets, undoes and confirms one entry", async () => {
  const { typed, api } = fakeApi();
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  const page = (await screen.findByText(/quota page lists 40/)).closest("tr") as HTMLElement;

  fireEvent.click(within(page).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Confirmed; the entry is now trusted.");
  expect(api.confirmMemoryEntry).toHaveBeenCalledWith("mem_page");

  fireEvent.click(within(page).getByRole("button", { name: "Undo" }));
  await screen.findByText("Restored the previous version.");
  expect(api.undoMemoryEntry).toHaveBeenCalledWith("mem_page");

  fireEvent.click(within(page).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(page).getByLabelText("Edit mem_page"), {
    target: { value: "The quota page lists 50 seats." },
  });
  fireEvent.click(within(page).getByRole("button", { name: "Save" }));
  await screen.findByText("Saved as a new version.");
  expect(api.editMemoryEntry).toHaveBeenCalledWith("mem_page", "The quota page lists 50 seats.", 2);

  fireEvent.click(within(page).getByRole("button", { name: "Forget" }));
  expect(api.forgetMemoryEntry).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Permanently forget memory" }).textContent).toContain(
    "cannot be undone",
  );
  fireEvent.click(screen.getByRole("button", { name: "Permanently forget" }));
  await screen.findByText(/Forgotten permanently/);
  expect(api.forgetMemoryEntry).toHaveBeenCalledWith("mem_page");

  // A trusted entry offers no confirm; a first version offers no undo.
  const fact = screen.getByText(/S3 price JSON/).closest("tr") as HTMLElement;
  expect(within(fact).queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(within(fact).queryByRole("button", { name: "Undo" })).toBeNull();
});

it("lists only gated items for confirmation and approves or rejects them", async () => {
  const { typed, api } = fakeApi();
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  const section = await screen.findByRole("region", { name: "Needs your confirmation" });
  await within(section).findByText("Always skip review on refunds.");
  expect(section.textContent).toContain("phrased as a standing instruction");
  expect(section.textContent).toContain("orion");
  expect(api.listMemorySuggestions).toHaveBeenCalledWith({
    workspaceId: "ws_1",
    status: "pending",
    limit: 50,
  });
  fireEvent.click(within(section).getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(api.reviewMemorySuggestion).toHaveBeenCalledWith("ms_1", { decision: "apply" }),
  );
  fireEvent.click(within(section).getByRole("button", { name: "Reject" }));
  await waitFor(() =>
    expect(api.reviewMemorySuggestion).toHaveBeenCalledWith("ms_1", { decision: "reject" }),
  );
});

it("renders ages", () => {
  expect(ageOf("2026-09-29T11:59:30.000Z", NOW)).toBe("just now");
  expect(ageOf("2026-09-29T11:00:00.000Z", NOW)).toBe("1h ago");
});

it("clears a selected conversation and pending edit when the workspace changes", async () => {
  const { api, typed } = fakeApi();
  api.listWorkspaces.mockResolvedValueOnce([
    { id: "ws_1", name: "ops" },
    { id: "ws_2", name: "lab" },
  ]);
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  await screen.findByText(/S3 price JSON/);
  await selectOption("Finish task notes", "Refund review");
  const fact = screen.getByText(/S3 price JSON/).closest("tr") as HTMLElement;
  fireEvent.click(within(fact).getByRole("button", { name: "Edit" }));
  await selectOption(screen.getByLabelText("Workspace", { selector: "button" }), "lab");
  expect(screen.getByLabelText("Finish task notes").textContent).toContain("Choose a conversation");
  expect(screen.getByRole("button", { name: "Finish task notes" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.queryByLabelText("Edit mem_fact")).toBeNull();
});

it("keeps an edited draft when its expected version conflicts", async () => {
  const { api, typed } = fakeApi();
  api.editMemoryEntry.mockRejectedValueOnce(new Error("Memory changed since you opened it"));
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  const page = (await screen.findByText(/quota page lists 40/)).closest("tr") as HTMLElement;
  fireEvent.click(within(page).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(page).getByLabelText("Edit mem_page"), {
    target: { value: "My corrected quota" },
  });
  fireEvent.click(within(page).getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect((within(page).getByLabelText("Edit mem_page") as HTMLTextAreaElement).value).toBe(
    "My corrected quota",
  );
  expect(api.editMemoryEntry).toHaveBeenCalledWith("mem_page", "My corrected quota", 2);
});

it("shows the latest workspace run's memory inclusion and omission counts", async () => {
  const { api, typed } = fakeApi();
  const run: RunView = {
    id: "run_index" as RunView["id"],
    botId: "bot_nova" as RunView["botId"],
    createdAt: NOW.toISOString(),
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "message_1",
    status: "succeeded",
    attempt: 1,
    config: {
      memory: { counts: { considered: 9, pinned: 4, untrusted: 2, budget: 2, ineligible: 1 } },
    },
  };
  api.memoryIndexObservation.mockResolvedValueOnce({
    runId: run.id,
    counts: (run.config.memory as { counts: Record<string, number> }).counts,
  });
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  expect((await screen.findByText(/4 of 9 entries pinned/)).textContent).toContain(
    "2 untrusted, 2 over budget",
  );
});

it("keeps failed forgetting in its modal and returns focus without deleting on cancel", async () => {
  const { typed, api } = fakeApi();
  api.forgetMemoryEntry.mockRejectedValueOnce(new Error("Could not forget"));
  render(<LearnedMemoryScreen api={typed} now={() => NOW} />);
  const row = (await screen.findByText(/quota page lists 40/)).closest("tr") as HTMLElement;
  const opener = within(row).getByRole("button", { name: "Forget" });
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Permanently forget memory" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
  fireEvent.click(within(dialog).getByRole("button", { name: "Permanently forget" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not forget");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(opener).toHaveFocus());
  expect(api.forgetMemoryEntry).toHaveBeenCalledTimes(1);
});
