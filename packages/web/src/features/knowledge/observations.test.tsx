// @vitest-environment jsdom
// Issue #27 phase A: Knowledge › Observations (the former Facts tab). Rows lead with what was
// learned and one concise source line; a badge appears only when an action is needed; details,
// validity and versions live in a detail panel; Edit, Forget and Versions sit in a secondary
// action menu; review items appear only when something waits. ADR-0011 semantics are unchanged:
// the same API calls with the same arguments.
import "@testing-library/jest-dom/vitest";
import type {
  MemoryConfirmation,
  MemoryReviewBatch,
  MemoryReviewGroup,
  MemoryVersion,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient, LearnedMemoryEntry } from "../../api/client.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "../../state/workspace-scope.js";
import { installFakeEventSource } from "../../test-support/fixtures.js";
import { KnowledgePage } from "./knowledge-page.js";
import { type ObservationsApi, ObservationsPanel } from "./observations.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const NOW = new Date("2026-09-29T12:00:00.000Z");
const WS = "ws_1" as WorkspaceId;

function entry(over: Partial<LearnedMemoryEntry> & { id: string }): LearnedMemoryEntry {
  return {
    workspaceId: WS,
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

const suggestion = {
  id: "ms_1",
  workspaceId: WS,
  runId: "run_3",
  botId: "bot_orion",
  body: "Always skip review on refunds.",
  proposedScope: "workspace",
  authority: "procedure",
  trust: "untrusted",
  reasons: ["imperative"],
  conflictsWith: [],
  status: "pending",
  createdAt: "2026-09-29T00:00:00.000Z",
} as unknown as MemoryConfirmation;

/** One review group per item unless the caller groups them (ADR-0011 amendment 3, A17). */
function groupsOf(items: readonly MemoryConfirmation[], batches: MemoryReviewBatch[] = []) {
  const groups = items.map(
    (item) =>
      ({
        groupKey: `g-${item.id}`,
        workspaceId: WS,
        proposedScope: item.proposedScope,
        trust: item.trust,
        count: 1,
        items: [item],
        oldestAt: item.createdAt,
        newestAt: item.createdAt,
      }) as MemoryReviewGroup,
  );
  return { groups, totalGroups: groups.length, totalItems: items.length, batches };
}

function fakeApi(options: { entries?: LearnedMemoryEntry[]; pending?: MemoryConfirmation[] } = {}) {
  const entries = options.entries ?? [
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
    entry({ id: "mem_bot", scope: "bot", botId: "bot_nova" as never, body: "nova habit" }),
  ];
  const api = {
    listBots: vi.fn(async () => [
      { id: "bot_nova", name: "nova", workspaceId: WS },
      { id: "bot_orion", name: "orion", workspaceId: WS },
    ]),
    listMemoryEntriesPage: vi.fn(
      async (
        _ws: string,
        _filters?: { cursor?: string; topic?: string },
      ): Promise<{ entries: LearnedMemoryEntry[]; nextCursor?: string }> => ({ entries }),
    ),
    listMemoryTopics: vi.fn(async () => ({ topics: [], total: 0 })),
    searchLearnedMemoryPage: vi.fn(
      async (): Promise<{ entries: LearnedMemoryEntry[]; nextCursor?: string }> => ({
        entries: entries.slice(0, 1),
      }),
    ),
    memoryProvenance: vi.fn(async () => ({ sources: [], supersessions: [] })),
    listMemoryReviewGroups: vi.fn(
      async (
        _ws: string,
        _filters?: { cursor?: string },
      ): Promise<ReturnType<typeof groupsOf> & { nextCursor?: string }> =>
        groupsOf(options.pending ?? []),
    ),
    previewMemoryBatch: vi.fn(async () => ({
      groupKey: "g-many",
      decision: "merge",
      itemIds: ["ms_1", "ms_2", "ms_3"],
      representativeId: "ms_1",
      remaining: 0,
      token: "tok-1",
    })),
    commitMemoryBatch: vi.fn(async () => ({})),
    undoMemoryBatch: vi.fn(async () => ({})),
    reviewMemorySuggestion: vi.fn(async () => ({ suggestion: {} })),
    editMemoryEntry: vi.fn(async () => ({})),
    forgetMemoryEntry: vi.fn(async () => ({})),
    undoMemoryEntry: vi.fn(async () => ({})),
    confirmMemoryEntry: vi.fn(async () => ({})),
    listMemoryVersionsPage: vi.fn(async () => ({
      versions: [
        {
          entryId: "mem_page",
          version: 1,
          op: "create",
          body: "The quota page lists 30 seats.",
          createdAt: "2026-09-25T00:00:00.000Z",
        },
      ] as unknown as MemoryVersion[],
    })),
  };
  return { api, typed: api as unknown as ObservationsApi };
}

function renderPanel(typed: ObservationsApi) {
  return render(<ObservationsPanel api={typed} workspaceId={WS} now={() => NOW} />);
}

async function rows(): Promise<HTMLElement[]> {
  const list = await screen.findByRole("list", { name: "Observations" });
  await waitFor(() => expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(0));
  return within(list).getAllByRole("listitem");
}

it("leads each row with its content and one concise source line, without bot experience", async () => {
  const { typed, api } = fakeApi();
  renderPanel(typed);
  const [fact, page, ...rest] = await rows();
  expect(rest).toEqual([]);
  expect(fact).toHaveTextContent("S3 price JSON shows egress as 0");
  expect(within(fact as HTMLElement).getByText("nova · 3d ago")).toBeInTheDocument();
  // Trusted rows carry no badge; only the untrusted one asks for an action.
  expect(within(fact as HTMLElement).queryByText("needs confirmation")).toBeNull();
  expect(within(page as HTMLElement).getByText("needs confirmation")).toBeInTheDocument();
  // Provenance details stay out of the row.
  expect(fact).not.toHaveTextContent("valid since");
  expect(api.listMemoryEntriesPage).toHaveBeenCalledWith(WS, { includeForgotten: false });
});

it("shows no review section when nothing waits, and Approve/Reject when something does", async () => {
  const quiet = fakeApi();
  const { unmount } = renderPanel(quiet.typed);
  await rows();
  expect(screen.queryByRole("region", { name: /waiting for review/i })).toBeNull();
  expect(screen.queryByText("Nothing is waiting for you.")).toBeNull();
  unmount();

  const { typed, api } = fakeApi({ pending: [suggestion] });
  renderPanel(typed);
  const review = await screen.findByRole("region", { name: "Observations waiting for review" });
  expect(within(review).getByRole("heading")).toHaveTextContent("Waiting for review (1)");
  expect(within(review).getByText("Always skip review on refunds.")).toBeInTheDocument();
  expect(within(review).getByText(/orion/)).toBeInTheDocument();
  expect(within(review).getByRole("link", { name: "Source run" })).toHaveAttribute(
    "href",
    "#/runs/run_3",
  );
  fireEvent.click(within(review).getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(api.reviewMemorySuggestion).toHaveBeenCalledWith("ms_1", { decision: "apply" }),
  );
  fireEvent.click(within(review).getByRole("button", { name: "Reject" }));
  await waitFor(() =>
    expect(api.reviewMemorySuggestion).toHaveBeenCalledWith("ms_1", { decision: "reject" }),
  );
});

it("loads further review groups, entries and search matches instead of dropping them (A15, A23)", async () => {
  const { typed, api } = fakeApi({ pending: [suggestion] });
  const second = { ...suggestion, id: "ms_2", body: "Never pay invoices twice." };
  api.listMemoryReviewGroups.mockImplementation(async (_ws, filters) =>
    filters?.cursor === "next"
      ? { ...groupsOf([second as MemoryConfirmation]), totalGroups: 2, totalItems: 2 }
      : { ...groupsOf([suggestion]), totalGroups: 2, totalItems: 2, nextCursor: "next" },
  );
  const more = entry({ id: "mem_26", body: "Entry twenty-six." });
  api.listMemoryEntriesPage.mockImplementation(async (_ws, filters) =>
    filters?.cursor === "e2"
      ? { entries: [more] }
      : { entries: [entry({ id: "mem_1", body: "Entry one." })], nextCursor: "e2" },
  );
  renderPanel(typed);
  const review = await screen.findByRole("region", { name: "Observations waiting for review" });
  // The heading counts the whole queue, not the loaded page.
  expect(within(review).getByRole("heading")).toHaveTextContent("Waiting for review (2)");
  fireEvent.click(within(review).getByRole("button", { name: "Load more" }));
  expect(await within(review).findByText("Never pay invoices twice.")).toBeInTheDocument();
  expect(api.listMemoryReviewGroups).toHaveBeenLastCalledWith(WS, { cursor: "next" });
  expect(within(review).queryByRole("button", { name: "Load more" })).toBeNull();

  expect(await screen.findByText("Entry one.")).toBeInTheDocument();
  fireEvent.click(
    screen
      .getAllByRole("button", { name: "Load more" })
      .find((b) => !review.contains(b)) as HTMLElement,
  );
  expect(await screen.findByText("Entry twenty-six.")).toBeInTheDocument();
  expect(api.listMemoryEntriesPage).toHaveBeenLastCalledWith(WS, {
    includeForgotten: false,
    cursor: "e2",
  });

  api.searchLearnedMemoryPage.mockImplementation(
    async (_ws?: string, _q?: string, filters?: { cursor?: string }) =>
      filters?.cursor === "c2"
        ? { entries: [entry({ id: "mem_21", body: "Match twenty-one." })] }
        : { entries: [entry({ id: "mem_m1", body: "Match one." })], nextCursor: "c2" },
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search active memory" }), {
    target: { value: "match" },
  });
  expect(await screen.findByText("Match one.")).toBeInTheDocument();
  expect(screen.getByText("Best matches first")).toBeInTheDocument();
  // A new search reloads the queue's first page too; the list's own "Load more" is outside it.
  const listMore = () =>
    screen
      .queryAllByRole("button", { name: "Load more" })
      .filter((button) => !review.contains(button));
  fireEvent.click(listMore()[0] as HTMLElement);
  expect(await screen.findByText("Match twenty-one.")).toBeInTheDocument();
  expect(api.searchLearnedMemoryPage).toHaveBeenLastCalledWith(WS, "match", { cursor: "c2" });
  expect(listMore()).toEqual([]);
});

it("shows one proposal from several runs as one group, previews a batch and undoes it (A17-A19)", async () => {
  const { typed, api } = fakeApi();
  const items = ["ms_1", "ms_2", "ms_3"].map(
    (id, n) =>
      ({
        ...suggestion,
        id,
        runId: `run_${n}`,
        body: n ? "always skip review on refunds" : suggestion.body,
      }) as MemoryConfirmation,
  );
  const group = {
    groupKey: "g-many",
    workspaceId: WS,
    proposedScope: "workspace",
    trust: "untrusted",
    count: 3,
    items,
    oldestAt: suggestion.createdAt,
    newestAt: suggestion.createdAt,
  } as MemoryReviewGroup;
  const batch = {
    id: "mrb_1",
    workspaceId: WS,
    groupKey: "g-many",
    decision: "merge",
    itemIds: ["ms_1", "ms_2", "ms_3"],
    entryId: "mem_new",
    createdEntry: true,
    decidedBy: "human:o",
    createdAt: "2026-09-29T01:00:00.000Z",
  } as MemoryReviewBatch;
  api.listMemoryReviewGroups.mockResolvedValue({
    groups: [group],
    totalGroups: 1,
    totalItems: 3,
    batches: [],
  });
  renderPanel(typed);
  const review = await screen.findByRole("region", { name: "Observations waiting for review" });
  expect(within(review).getByRole("heading")).toHaveTextContent(
    "Waiting for review (3 in 1 groups)",
  );
  expect(within(review).getByText("Proposed 3 times, from different runs")).toBeInTheDocument();
  expect(within(review).getAllByRole("link", { name: "Source run" })).toHaveLength(3);
  fireEvent.click(within(review).getByRole("button", { name: "Confirm once for all 3" }));
  const preview = await within(review).findByRole("alertdialog", { name: "Batch preview" });
  expect(api.previewMemoryBatch).toHaveBeenCalledWith(WS, {
    groupKey: "g-many",
    decision: "merge",
  });
  // Nothing is decided by the preview itself.
  expect(api.commitMemoryBatch).not.toHaveBeenCalled();
  api.listMemoryReviewGroups.mockResolvedValue({
    groups: [],
    totalGroups: 0,
    totalItems: 0,
    batches: [batch],
  });
  fireEvent.click(within(preview).getByRole("button", { name: "Apply to this group" }));
  await waitFor(() =>
    expect(api.commitMemoryBatch).toHaveBeenCalledWith(WS, {
      groupKey: "g-many",
      decision: "merge",
      token: "tok-1",
    }),
  );
  expect(await screen.findByText("Last batch: 3 items confirmed as one note.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo batch" }));
  await waitFor(() => expect(api.undoMemoryBatch).toHaveBeenCalledWith(WS, "mrb_1"));
});

it("filters the list by a topic tag and counts the topics it does not show (A20)", async () => {
  const { typed, api } = fakeApi();
  api.listMemoryTopics.mockResolvedValue({
    topics: [{ key: "vendordb", label: "VendorDB", count: 2 }],
    total: 30,
  } as never);
  renderPanel(typed);
  const tags = await screen.findByRole("navigation", { name: "Topics" });
  expect(within(tags).getByText("1 of 30 topics shown")).toBeInTheDocument();
  fireEvent.click(within(tags).getByRole("button", { name: "VendorDB (2)" }));
  await waitFor(() =>
    expect(api.listMemoryEntriesPage).toHaveBeenLastCalledWith(WS, {
      includeForgotten: false,
      topic: "vendordb",
    }),
  );
  expect(within(tags).getByRole("button", { name: "VendorDB (2)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("shows an entry's sources and replacements without asking for a decision (A12)", async () => {
  const { typed, api } = fakeApi();
  api.memoryProvenance.mockResolvedValue({
    sources: [
      {
        entryId: "mem_page",
        sourceRunId: "run_2",
        sourceKind: "page",
        trust: "untrusted",
        effectiveAt: "2026-09-26T12:00:00.000Z",
        effectiveBasis: "source",
        recordedAt: "2026-09-26T12:00:00.000Z",
      },
    ],
    supersessions: [
      {
        id: "msup_1",
        entryId: "mem_old",
        winnerId: "mem_page",
        factKey: "list page quota seat",
        reason: "newer_effective_time",
        entryEffectiveAt: "2026-09-20T12:00:00.000Z",
        winnerEffectiveAt: "2026-09-26T12:00:00.000Z",
        decidedBy: "bot:bot_orion",
        createdAt: "2026-09-26T12:00:01.000Z",
      },
    ],
  } as never);
  renderPanel(typed);
  const [, page] = await rows();
  fireEvent.click(within(page as HTMLElement).getByRole("button", { name: /^The quota page/ }));
  const detail = await screen.findByRole("complementary", { name: "Observation details" });
  expect(await within(detail).findByText("Sources (1)")).toBeInTheDocument();
  expect(
    within(detail).getByText("Replaced an older value on 2026-09-26: newer observation"),
  ).toBeInTheDocument();
  expect(api.memoryProvenance).toHaveBeenCalledWith("mem_page");
  expect(screen.queryByRole("region", { name: /waiting for review/i })).toBeNull();
});

it("opens details with source, validity and trust, and confirms an untrusted entry", async () => {
  const { typed, api } = fakeApi();
  renderPanel(typed);
  const [, page] = await rows();
  fireEvent.click(within(page as HTMLElement).getByRole("button", { name: /^The quota page/ }));
  const detail = await screen.findByRole("complementary", { name: "Observation details" });
  expect(detail).toHaveTextContent("learned by orion from run run_2");
  expect(detail).toHaveTextContent("after reading page content");
  expect(detail).toHaveTextContent("valid since 2026-09-26");
  expect(detail).toHaveTextContent("untrusted");
  expect(within(detail).getByRole("link", { name: "run_2" })).toHaveAttribute(
    "href",
    "#/runs/run_2",
  );
  fireEvent.click(within(detail).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.confirmMemoryEntry).toHaveBeenCalledWith("mem_page"));
  fireEvent.click(within(detail).getByRole("button", { name: "Close details" }));
  expect(screen.queryByRole("complementary", { name: "Observation details" })).toBeNull();
});

it("keeps Edit, Forget, Versions and Undo in the row's action menu", async () => {
  const { typed, api } = fakeApi();
  renderPanel(typed);
  const [fact, page] = await rows();

  fireEvent.click(
    within(fact as HTMLElement).getByRole("button", { name: /More actions for S3 price JSON/ }),
  );
  const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  // Undo appears only when there is a previous version; Confirm only for untrusted entries.
  expect(items).toEqual(["Edit", "Versions", "Forget"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  const detail = await screen.findByRole("complementary", { name: "Observation details" });
  fireEvent.change(within(detail).getByLabelText("Edit mem_fact"), {
    target: { value: "S3 egress is billed separately." },
  });
  fireEvent.click(within(detail).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.editMemoryEntry).toHaveBeenCalledWith(
      "mem_fact",
      "S3 egress is billed separately.",
      1,
    ),
  );

  fireEvent.click(
    within(page as HTMLElement).getByRole("button", { name: /More actions for The quota page/ }),
  );
  await waitFor(() =>
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Edit",
      "Versions",
      "Undo",
      "Confirm",
      "Forget",
    ]),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Versions" }));
  const versions = await screen.findByRole("region", { name: "Memory versions" });
  expect(versions).toHaveTextContent("The quota page lists 30 seats.");
  expect(api.listMemoryVersionsPage).toHaveBeenCalledWith("mem_page", {});

  fireEvent.click(
    within(page as HTMLElement).getByRole("button", { name: /More actions for The quota page/ }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Undo" }));
  await waitFor(() => expect(api.undoMemoryEntry).toHaveBeenCalledWith("mem_page"));

  fireEvent.click(
    within(page as HTMLElement).getByRole("button", { name: /More actions for The quota page/ }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Forget" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Permanently forget memory" });
  expect(api.forgetMemoryEntry).not.toHaveBeenCalled();
  fireEvent.click(within(confirm).getByRole("button", { name: "Permanently forget" }));
  await waitFor(() => expect(api.forgetMemoryEntry).toHaveBeenCalledWith("mem_page"));
});

it("shows its rows under StrictMode's double mount, as the app renders it", async () => {
  const { typed } = fakeApi();
  render(
    <StrictMode>
      <ObservationsPanel api={typed} workspaceId={WS} now={() => NOW} />
    </StrictMode>,
  );
  expect(await screen.findByText(/S3 price JSON/)).toBeInTheDocument();
  expect(screen.queryByText("Loading observations…")).toBeNull();
});

it("searches active memory and says when nothing matches", async () => {
  const { typed, api } = fakeApi({ entries: [] });
  renderPanel(typed);
  expect(await screen.findByText(/No observations yet/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search active memory" }), {
    target: { value: "quota" },
  });
  await waitFor(() => expect(api.searchLearnedMemoryPage).toHaveBeenCalledWith(WS, "quota"));
});

it("reports a load failure instead of an empty list", async () => {
  const { typed, api } = fakeApi();
  api.listMemoryEntriesPage.mockRejectedValueOnce(new Error("Gateway unavailable"));
  renderPanel(typed);
  expect(await screen.findByRole("alert")).toHaveTextContent("Gateway unavailable");
  expect(screen.queryByText(/No observations yet/)).toBeNull();
});

it("does not show a previous workspace's observations or late answers after switching", async () => {
  installFakeEventSource();
  const workspaces = [
    { id: "ws_1", name: "alpha", egressAllowlist: ["*"] },
    { id: "ws_2", name: "beta", egressAllowlist: ["*"] },
  ] as unknown as Workspace[];
  let releaseAlpha: (value: { entries: LearnedMemoryEntry[] }) => void = () => {};
  const api = {
    ...fakeApi().api,
    listWorkspaces: vi.fn(async () => workspaces),
    listMemoryEntriesPage: vi.fn((workspaceId: string) =>
      workspaceId === "ws_1"
        ? new Promise<{ entries: LearnedMemoryEntry[] }>((resolve) => {
            releaseAlpha = resolve;
          })
        : Promise.resolve({
            entries: [
              entry({ id: "mem_beta", workspaceId: "ws_2" as WorkspaceId, body: "Beta fact." }),
            ],
          }),
    ),
  };
  function Switcher() {
    const scope = useWorkspaceScope(api as unknown as ApiClient);
    return (
      <button type="button" onClick={() => scope.select("ws_2" as WorkspaceId)}>
        switch
      </button>
    );
  }
  render(
    <WorkspaceScopeProvider api={api as unknown as ApiClient} initialWorkspaceId={WS}>
      <Switcher />
      <KnowledgePage api={api as unknown as ApiClient} tab="observations" />
    </WorkspaceScopeProvider>,
  );
  await waitFor(() =>
    expect(api.listMemoryEntriesPage).toHaveBeenCalledWith("ws_1", expect.anything()),
  );
  fireEvent.click(screen.getByRole("button", { name: "switch" }));
  expect(await screen.findByText("Beta fact.")).toBeInTheDocument();
  await act(async () =>
    releaseAlpha({ entries: [entry({ id: "mem_alpha", body: "Alpha fact." })] }),
  );
  expect(screen.queryByText("Alpha fact.")).toBeNull();
  expect(screen.getByText("Beta fact.")).toBeInTheDocument();
});

// jsdom lacks CSS.escape; React Aria uses it for generated IDs.
if (!globalThis.CSS?.escape) {
  globalThis.CSS = {
    ...globalThis.CSS,
    escape: (value: string) =>
      Array.from(value, (char) => `\\${char.codePointAt(0)?.toString(16)} `).join(""),
  };
}
