// @vitest-environment jsdom
// T0: User Settings › Workspaces (ADR-0034 decisions 4 and 1): 20 rows a page from the server
// with an honest range, search and filters reset to page one and stay in the address, and the
// full-page detail keyed by ID with Back to the same list and the weighted rename bound.

import "@testing-library/jest-dom/vitest";
import type {
  Workspace,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryQuery,
  WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { WorkspaceManagement } from "./workspace-management.js";

function entry(i: number, extra: Partial<WorkspaceDirectoryEntry> = {}): WorkspaceDirectoryEntry {
  return {
    id: `ws_${String(i).padStart(2, "0")}` as WorkspaceId,
    name: `team ${i}`,
    myRole: "owner",
    pinned: false,
    botCount: i % 3,
    activeRuns: 0,
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    openInternet: true,
    ...extra,
  };
}

const ROWS = Array.from({ length: 45 }, (_, i) => entry(i));

function fakeApi(rows = ROWS) {
  const listWorkspaceDirectory = vi.fn(async (q: WorkspaceDirectoryQuery = {}) => {
    const matching = rows.filter(
      (row) =>
        (!q.q || row.name.includes(q.q) || row.id === q.q) &&
        (q.filter !== "pinned" || row.pinned) &&
        (q.filter === "archived" ? Boolean(row.archivedAt) : !row.archivedAt),
    );
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 20;
    return {
      workspaces: matching.slice(offset, offset + limit),
      offset,
      limit,
      total: matching.length,
    };
  });
  const renameWorkspace = vi.fn(
    async (id: WorkspaceId, name: string) =>
      ({ id, name, egressAllowlist: ["*"] }) as unknown as Workspace,
  );
  const api = {
    listWorkspaces: vi.fn(async () => [] as Workspace[]),
    listWorkspaceDirectory,
    renameWorkspace,
    setWorkspacePinned: vi.fn(async () => {}),
  } as unknown as ApiClient;
  return { api, listWorkspaceDirectory, renameWorkspace };
}

beforeEach(() => {
  window.history.replaceState(null, "", "#/account/workspaces");
});
afterEach(() => cleanup());

describe("Workspaces list", () => {
  it("shows 20 of 45 with the total, pages forward, and returns to page one on a new search", async () => {
    const { api, listWorkspaceDirectory } = fakeApi();
    render(<WorkspaceManagement api={api} />);
    expect(await screen.findByText("1–20 / 45")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Workspaces 45 workspaces/ })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(21);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("21–40 / 45")).toBeInTheDocument();
    expect(listWorkspaceDirectory).toHaveBeenLastCalledWith({ offset: 20, limit: 20 });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search workspaces by name or ID" }), {
      target: { value: "team 4" },
    });
    expect(await screen.findByText("1–6 / 6")).toBeInTheDocument();
    expect(listWorkspaceDirectory).toHaveBeenLastCalledWith({ q: "team 4", offset: 0, limit: 20 });
    expect(window.location.hash).toBe("#/account/workspaces?q=team+4");
    const link = screen.getByRole("link", { name: "team 4" });
    expect(link).toHaveAttribute("href", "#/account/workspaces?q=team+4&ws=ws_04");
  });

  it("filters by Pinned and says when nothing matches", async () => {
    const { api, listWorkspaceDirectory } = fakeApi();
    render(<WorkspaceManagement api={api} list={{ filter: "pinned" }} />);
    expect(
      await screen.findByText("No workspace matches this search and these filters."),
    ).toBeInTheDocument();
    expect(listWorkspaceDirectory).toHaveBeenCalledWith({ filter: "pinned", offset: 0, limit: 20 });
    expect(screen.getByRole("button", { name: "Pinned" })).toHaveAttribute("aria-pressed", "true");
  });

  it("hides running work below Admin and truncates a long legacy name with its full title", async () => {
    const long = "x".repeat(60);
    const { api } = fakeApi([entry(1, { myRole: "member", activeRuns: null, name: long })]);
    render(<WorkspaceManagement api={api} />);
    const link = await screen.findByRole("link", { name: long });
    expect(link).toHaveAttribute("title", long);
    expect(screen.getAllByText("Visible to Admins and Owners").length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: "Member" })).toBeInTheDocument();
  });
});

describe("Workspace detail", () => {
  it("opens by ID, links back to the same list and enforces the weighted name bound", async () => {
    const { api, renameWorkspace } = fakeApi();
    render(<WorkspaceManagement api={api} workspaceId="ws_04" list={{ q: "team" }} />);
    expect(await screen.findByRole("heading", { name: "team 4" })).toBeInTheDocument();
    expect(screen.getByText("ws_04")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to workspace list/ })).toHaveAttribute(
      "href",
      "#/account/workspaces?q=team",
    );
    const field = screen.getByRole("textbox", { name: /Rename/ });
    fireEvent.change(field, { target: { value: "研".repeat(17) } });
    expect(screen.getByText("34/32")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Too long: 34 of 32 units.");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "研".repeat(16) } });
    expect(screen.getByText("32/32")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(renameWorkspace).toHaveBeenCalledWith("ws_04", "研".repeat(16)));
    expect(await screen.findByText("Name saved.")).toBeInTheDocument();
  });

  it("says a workspace the caller cannot see is not found", async () => {
    const { api } = fakeApi();
    render(<WorkspaceManagement api={api} workspaceId="ws_missing" />);
    expect(
      await screen.findByText("This workspace does not exist, or you no longer have access to it."),
    ).toBeInTheDocument();
  });
});
