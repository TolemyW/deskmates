// @vitest-environment jsdom
// ADR-0011 amendment 4 (issue #85 phase 2): the maintenance panel under Observations. Flags are
// answered with the same API calls the Gateway expects; a draft cites only trusted current notes;
// organisation and splits are explicit actions; empty, partial and error states say so.
import "@testing-library/jest-dom/vitest";
import type {
  MemoryOrganizeJob,
  MemoryRevalidation,
  MemorySplitProposal,
  WorkspaceId,
} from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LearnedMemoryEntry } from "../../api/client.js";
import { MemoryMaintenance, type MemoryMaintenanceApi } from "./memory-maintenance.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WS = "ws_1" as WorkspaceId;

function flag(id: string, over: Partial<MemoryRevalidation> = {}): MemoryRevalidation {
  return {
    id,
    workspaceId: WS,
    entryId: `mem_${id}`,
    entryVersion: 1,
    reason: "age",
    status: "open",
    flaggedAt: "2026-10-14T00:00:00.000Z",
    horizonDays: 1,
    needsHuman: true,
    entry: {
      body: `The billing export runs on Mondays (${id}).`,
      scope: "workspace",
      trust: "trusted",
      version: 1,
      effectiveAt: "2026-05-01T00:00:00.000Z",
    },
    ...over,
  };
}

function entry(id: string, over: Partial<LearnedMemoryEntry> = {}): LearnedMemoryEntry {
  return {
    id,
    workspaceId: WS,
    scope: "workspace",
    kind: "note",
    body: `VendorDB fact ${id}`,
    authority: "fact",
    trust: "trusted",
    sourceKind: "bot_self",
    derivedFrom: [],
    observedAt: "2026-10-01T00:00:00.000Z",
    validFrom: "2026-10-01T00:00:00.000Z",
    version: 1,
    tombstoned: false,
    live: true,
    ...over,
  };
}

const split: MemorySplitProposal = {
  id: "msplit_1",
  workspaceId: WS,
  entryId: "mem_mixed",
  entryVersion: 1,
  body: "VendorDB accepts duplicate keys and the orders table holds 20 columns",
  parts: ["VendorDB accepts duplicate keys", "the orders table holds 20 columns"],
  status: "pending",
  runId: "run_1",
  createdAt: "2026-10-14T00:00:00.000Z",
};

function fakeApi(over: Partial<MemoryMaintenanceApi> = {}) {
  const api = {
    listMemoryRevalidations: vi.fn(async () => ({
      revalidations: [flag("a", { reason: "ttl_expired" })],
      nextCursor: "c1",
      total: 2,
      needsHuman: 2,
      byReason: { ttl_expired: 1, age: 1 },
    })),
    getMemoryMaintenance: vi.fn(async () => ({
      settings: { recheckDailyLimit: 200, organizeDaily: true },
      recheckedToday: 12,
      recheck: {
        id: "mrck_1",
        workspaceId: WS,
        status: "ready" as const,
        runId: "run_r",
        noteCount: 12,
        stillTrue: 9,
        possiblyStale: 2,
        unclear: 1,
        dropped: 0,
        createdAt: "2026-10-14T00:00:00.000Z",
        finishedAt: "2026-10-14T00:01:00.000Z",
      },
    })),
    updateMemoryMaintenanceSettings: vi.fn(async (_ws: WorkspaceId, patch: object) => ({
      recheckDailyLimit: 200,
      organizeDaily: true,
      ...patch,
    })),
    decideMemoryRevalidation: vi.fn(async (_ws: WorkspaceId, id: string) => flag(id)),
    draftKnowledgeFromObservations: vi.fn(async () => ({
      id: "kp_1",
      title: "VendorDB",
      body: "",
      status: "pending" as const,
      createdAt: "2026-10-14T00:00:00.000Z",
    })),
    getMemoryOrganizeJob: vi.fn(async (): Promise<MemoryOrganizeJob | undefined> => undefined),
    requestMemoryOrganize: vi.fn(
      async (): Promise<MemoryOrganizeJob> => ({
        id: "morg_1",
        workspaceId: WS,
        status: "ready",
        runId: "run_1",
        noteCount: 3,
        labelsKept: 1,
        labelsDropped: 0,
        splitsKept: 1,
        splitsDropped: 0,
        requestedBy: "user:u",
        createdAt: "2026-10-14T00:00:00.000Z",
      }),
    ),
    resetMemoryTopicLabels: vi.fn(async () => 0),
    listMemorySplits: vi.fn(async () => ({ splits: [split], total: 1 })),
    decideMemorySplit: vi.fn(async (_ws: WorkspaceId, _id: string, decision: string) => ({
      ...split,
      status: decision === "accept" ? ("accepted" as const) : ("rejected" as const),
    })),
    listMemoryTopics: vi.fn(async () => ({
      topics: [{ key: "vendordb", label: "VendorDB", count: 2 }],
      total: 1,
    })),
    listMemoryEntriesPage: vi.fn(async () => ({
      entries: [entry("t1"), entry("u1", { trust: "untrusted" })],
    })),
    ...over,
  };
  return api;
}

const renderPanel = (api: ReturnType<typeof fakeApi>) =>
  render(<MemoryMaintenance api={api as unknown as MemoryMaintenanceApi} workspaceId={WS} />);

it("lists flags with reasons and a partial count, and answers one with Still true", async () => {
  const api = fakeApi();
  renderPanel(api);
  expect(await screen.findByText("Needs revalidation (2)")).toBeInTheDocument();
  expect(screen.getByText("Expired: 1 · Not confirmed in the last day: 1")).toBeInTheDocument();
  expect(screen.getByText("Showing 1 of 2")).toBeInTheDocument();
  expect(api.listMemoryRevalidations).toHaveBeenCalledWith(WS, { view: "needs_human" });
  fireEvent.click(screen.getByRole("button", { name: "Still true" }));
  await waitFor(() =>
    expect(api.decideMemoryRevalidation).toHaveBeenCalledWith(WS, "a", "still_true"),
  );
  expect(await screen.findByText("Marked as still true.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() =>
    expect(api.listMemoryRevalidations).toHaveBeenCalledWith(WS, {
      view: "needs_human",
      cursor: "c1",
    }),
  );
});

it("says when nothing needs revalidation", async () => {
  const api = fakeApi({
    listMemoryRevalidations: vi.fn(async () => ({
      revalidations: [],
      total: 0,
      needsHuman: 0,
      byReason: {},
    })),
  });
  renderPanel(api);
  expect(await screen.findByText("Nothing needs revalidation.")).toBeInTheDocument();
});

it("lands on what needs a person, shows the model's verdict, and switches to all flags (A28)", async () => {
  const stale = flag("s", {
    model: {
      verdict: "possibly_stale",
      reason: "Bob said exports moved to Tuesdays",
      checkedAt: "2026-10-14T03:00:00.000Z",
      runId: "run_r",
      entryVersion: 1,
    },
  });
  const api = fakeApi({
    listMemoryRevalidations: vi.fn(
      async (_ws: WorkspaceId, filters?: { view?: string; cursor?: string }) =>
        filters?.view === "all"
          ? { revalidations: [stale, flag("b")], total: 7, needsHuman: 1, byReason: { age: 7 } }
          : { revalidations: [], total: 7, needsHuman: 0, byReason: { age: 7 } },
    ),
  });
  renderPanel(api);
  expect(
    await screen.findByText(
      "Nothing needs a person. The AI model rechecks the other flagged notes on its own.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "12 of 200 note checks submitted in the last 24 hours, including failed attempts.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Last recheck: 9 still true, 2 possibly stale, 1 unclear."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "All flagged (7)" }));
  expect(
    await screen.findByText(
      "AI model recheck 2026-10-14: possibly stale. Bob said exports moved to Tuesdays",
    ),
  ).toBeInTheDocument();
  expect(api.listMemoryRevalidations).toHaveBeenCalledWith(WS, { view: "all" });
});

it("saves the maintenance settings and refuses an invalid limit (A34)", async () => {
  const api = fakeApi();
  renderPanel(api);
  const limit = await screen.findByLabelText("Notes rechecked per day (0 turns it off)");
  fireEvent.change(limit, { target: { value: "-1" } });
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  fireEvent.change(limit, { target: { value: "0" } });
  fireEvent.click(screen.getByLabelText("Organise topics once a day"));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(api.updateMemoryMaintenanceSettings).toHaveBeenCalledWith(WS, {
      recheckDailyLimit: 0,
      organizeDaily: false,
    }),
  );
  expect(await screen.findByText("Maintenance settings saved.")).toBeInTheDocument();
});

it("keeps failed initial reads distinct from empty maintenance and retries", async () => {
  const api = fakeApi();
  vi.mocked(api.listMemoryRevalidations).mockRejectedValueOnce(new Error("Gateway unavailable"));
  renderPanel(api);
  expect(await screen.findByRole("alert")).toHaveTextContent("Gateway unavailable");
  expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry maintenance" }));
  expect(await screen.findByRole("combobox")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(api.listMemoryRevalidations).toHaveBeenCalledTimes(2);
  expect(api.updateMemoryMaintenanceSettings).not.toHaveBeenCalled();
});

it("drafts a document from the trusted notes of one topic only", async () => {
  const api = fakeApi();
  renderPanel(api);
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "vendordb" } });
  const notes = await screen.findByRole("list", { name: "Notes of this topic" });
  const boxes = await within(notes).findAllByRole("checkbox");
  expect(boxes[0]).toBeChecked();
  expect(boxes[1]).toBeDisabled();
  expect(screen.getByText("(untrusted: confirm it first)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create draft from 1 notes" }));
  await waitFor(() =>
    expect(api.draftKnowledgeFromObservations).toHaveBeenCalledWith(WS, {
      entryIds: ["t1"],
      title: "VendorDB",
    }),
  );
  expect(
    await screen.findByText("Draft with 1 notes sent to Documents for review."),
  ).toBeInTheDocument();
});

it("asks for organisation explicitly and accepts, then undoes, a split", async () => {
  const api = fakeApi();
  renderPanel(api);
  expect(await screen.findByText("Proposed splits (1)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Suggest topics and splits" }));
  await waitFor(() => expect(api.requestMemoryOrganize).toHaveBeenCalledWith(WS));
  fireEvent.click(await screen.findByRole("button", { name: "Accept split" }));
  await waitFor(() => expect(api.decideMemorySplit).toHaveBeenCalledWith(WS, "msplit_1", "accept"));
  fireEvent.click(await screen.findByRole("button", { name: "Undo split" }));
  await waitFor(() => expect(api.decideMemorySplit).toHaveBeenCalledWith(WS, "msplit_1", "undo"));
});

it("preserves settings and document choices when maintenance refreshes", async () => {
  const api = fakeApi();
  renderPanel(api);
  const limit = await screen.findByLabelText("Notes rechecked per day (0 turns it off)");
  fireEvent.change(limit, { target: { value: "17" } });
  fireEvent.click(screen.getByLabelText("Organise topics once a day"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "vendordb" } });
  const notes = await screen.findByRole("list", { name: "Notes of this topic" });
  const boxes = await within(notes).findAllByRole("checkbox");
  const first = boxes[0];
  if (!first) throw new Error("Missing trusted note");
  fireEvent.click(first);
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "My draft title" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^All flagged/ }));
  await waitFor(() => expect(api.listMemoryTopics).toHaveBeenCalledTimes(2));
  expect(limit).toHaveValue(17);
  expect(screen.getByLabelText("Organise topics once a day")).not.toBeChecked();
  expect(screen.getByLabelText("Document title")).toHaveValue("My draft title");
  expect(boxes[0]).not.toBeChecked();
  expect(api.listMemoryEntriesPage).toHaveBeenCalledOnce();
  expect(api.updateMemoryMaintenanceSettings).not.toHaveBeenCalled();
  expect(api.draftKnowledgeFromObservations).not.toHaveBeenCalled();
});

it("ignores a delayed older page after changing the flag view", async () => {
  const api = fakeApi();
  const original = api.listMemoryRevalidations;
  type Page = Awaited<ReturnType<MemoryMaintenanceApi["listMemoryRevalidations"]>>;
  let finish!: (value: Page) => void;
  api.listMemoryRevalidations = vi.fn(
    (...args: Parameters<MemoryMaintenanceApi["listMemoryRevalidations"]>) => {
      const [workspace, filters] = args;
      if (filters?.cursor)
        return new Promise<Page>((resolve) => {
          finish = resolve;
        });
      return original(workspace, filters);
    },
  );
  renderPanel(api);
  const more = await screen.findByRole("button", { name: "Load more" });
  fireEvent.click(more);
  expect(more).toBeDisabled();
  fireEvent.click(more);
  expect(api.listMemoryRevalidations).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: /^All flagged/ }));
  await waitFor(() => expect(api.listMemoryRevalidations).toHaveBeenCalledTimes(3));
  await act(async () => {
    finish({
      revalidations: [flag("late", { entry: { ...flag("late").entry, body: "Old filtered row" } })],
      total: 2,
      needsHuman: 2,
      byReason: {},
    });
  });
  expect(screen.queryByText("Old filtered row")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
});
