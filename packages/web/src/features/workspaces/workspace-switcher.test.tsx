// @vitest-environment jsdom
// T0: the switcher is bounded (ADR-0034 decision 8): with 30 workspaces it renders the current
// one, at most five pinned and five recent, server search results, and "Manage all"; a late
// search answer never replaces a newer one.

import type {
  Workspace,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryPage,
  WorkspaceDirectoryQuery,
  WorkspaceId,
} from "@deskmates/contracts";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceScope } from "../../state/workspace-scope.js";
import { WorkspaceSwitcher } from "./workspace-switcher.js";

const workspaces: Workspace[] = Array.from({ length: 30 }, (_, i) => ({
  id: `ws_${String(i).padStart(2, "0")}` as WorkspaceId,
  name: `team ${i}`,
  sandboxProvider: "docker",
  status: "ready",
  egressAllowlist: ["*"],
  createdAt: "2026-10-01T00:00:00.000Z",
}));

function entry(w: Workspace, pinned = false): WorkspaceDirectoryEntry {
  return {
    id: w.id,
    name: w.name,
    myRole: "owner",
    pinned,
    botCount: 0,
    activeRuns: 0,
    lastActivityAt: w.createdAt,
    createdAt: w.createdAt,
    openInternet: true,
  };
}

function page(rows: WorkspaceDirectoryEntry[]): WorkspaceDirectoryPage {
  return { workspaces: rows, offset: 0, limit: rows.length, total: rows.length };
}

function scopeWith(
  listWorkspaceDirectory: (q?: WorkspaceDirectoryQuery) => Promise<WorkspaceDirectoryPage>,
): WorkspaceScope {
  return {
    workspaces,
    current: workspaces[0],
    loaded: true,
    error: undefined,
    reload: async () => {},
    select: vi.fn(),
    add: () => {},
    update: () => {},
    openCreate: () => {},
    directory: { listWorkspaceDirectory },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WorkspaceSwitcher (ADR-0034 decision 8)", () => {
  it("renders the current workspace, five pinned, five recent and Manage all, never all 30", async () => {
    const list = vi.fn(async (q?: WorkspaceDirectoryQuery) =>
      q?.filter === "pinned"
        ? page(workspaces.slice(1, 8).map((w) => entry(w, true)))
        : page(workspaces.slice(0, 11).map((w) => entry(w))),
    );
    render(<WorkspaceSwitcher scope={scopeWith(list)} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace: team 0" }));
    const menu = screen.getByRole("menu", { name: "Workspaces" });
    // Before the directory answers: the current workspace and a few already loaded.
    expect(within(menu).getAllByRole("menuitemradio").length).toBeLessThanOrEqual(6);
    await screen.findByRole("group", { name: "Pinned" });
    const pinned = within(screen.getByRole("group", { name: "Pinned" })).getAllByRole(
      "menuitemradio",
    );
    const recent = within(screen.getByRole("group", { name: "Recent" })).getAllByRole(
      "menuitemradio",
    );
    expect(pinned.map((item) => item.textContent)).toEqual(
      [1, 2, 3, 4, 5].map((i) => expect.stringContaining(`team ${i}`)),
    );
    expect(recent).toHaveLength(5);
    // Pinned rows are not repeated as recent ones.
    expect(recent.map((item) => item.textContent)).toEqual(
      [6, 7, 8, 9, 10].map((i) => expect.stringContaining(`team ${i}`)),
    );
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(11);
    expect(within(menu).getByRole("menuitem", { name: /Manage all workspaces/ })).toHaveAttribute(
      "href",
      "#/account/workspaces",
    );
    expect(list).toHaveBeenCalledWith({ filter: "pinned", limit: 5 });
  });

  it("searches on the server and drops an answer that arrives after a newer one", async () => {
    vi.useFakeTimers();
    const answers: Record<string, (p: WorkspaceDirectoryPage) => void> = {};
    const list = vi.fn((q?: WorkspaceDirectoryQuery) => {
      if (!q?.q) return Promise.reject(new Error("not in this test"));
      return new Promise<WorkspaceDirectoryPage>((resolve) => {
        answers[q.q as string] = resolve;
      });
    });
    render(<WorkspaceSwitcher scope={scopeWith(list)} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace: team 0" }));
    const search = screen.getByRole("searchbox", { name: "Search workspaces" });
    fireEvent.change(search, { target: { value: "team 1" } });
    await act(async () => vi.advanceTimersByTime(250));
    fireEvent.change(search, { target: { value: "team 2" } });
    await act(async () => vi.advanceTimersByTime(250));
    expect(list).toHaveBeenCalledWith({ q: "team 2", limit: 8 });
    await act(async () => answers["team 2"]?.(page([entry(workspaces[2] as Workspace)])));
    await act(async () => answers["team 1"]?.(page([entry(workspaces[1] as Workspace)])));
    const results = screen.getByRole("group", { name: "Search results" });
    expect(
      within(results)
        .getAllByRole("menuitemradio")
        .map((i) => i.textContent),
    ).toEqual([expect.stringContaining("team 2")]);
  });
});
