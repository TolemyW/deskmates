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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    horizonDays: 90,
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
      byReason: { ttl_expired: 1, age: 1 },
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
  expect(screen.getByText("Expired: 1 · Not confirmed for a long time: 1")).toBeInTheDocument();
  expect(screen.getByText("Showing 1 of 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Still true" }));
  await waitFor(() =>
    expect(api.decideMemoryRevalidation).toHaveBeenCalledWith(WS, "a", "still_true"),
  );
  expect(await screen.findByText("Marked as still true.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() =>
    expect(api.listMemoryRevalidations).toHaveBeenCalledWith(WS, { cursor: "c1" }),
  );
});

it("says when nothing needs revalidation", async () => {
  const api = fakeApi({
    listMemoryRevalidations: vi.fn(async () => ({ revalidations: [], total: 0, byReason: {} })),
  });
  renderPanel(api);
  expect(await screen.findByText("Nothing needs revalidation.")).toBeInTheDocument();
});

it("shows an error when the queue cannot be read", async () => {
  const api = fakeApi({
    listMemoryRevalidations: vi.fn(async () => {
      throw new Error("Gateway unavailable");
    }),
  });
  renderPanel(api);
  expect(await screen.findByRole("alert")).toHaveTextContent("Gateway unavailable");
});

it("drafts a document from the trusted notes of one topic only", async () => {
  const api = fakeApi();
  renderPanel(api);
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "vendordb" } });
  const boxes = await screen.findAllByRole("checkbox");
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
