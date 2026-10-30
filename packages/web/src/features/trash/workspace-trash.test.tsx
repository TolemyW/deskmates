// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { SessionRoles, Workspace } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { parseRoute } from "../../router.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "../../state/workspace-scope.js";
import {
  FakeEventSource,
  fakeFetch,
  installFakeEventSource,
  workspace,
} from "../../test-support/fixtures.js";
import { ComputerScreen } from "../computer/computer.js";
import { WorkspaceSwitcher } from "../workspaces/workspace-switcher.js";
import { WorkspaceTrashScreen } from "./workspace-trash.js";

const archived = { ...workspace, archivedAt: "2026-10-12T00:00:00Z" };
const peer = { ...workspace, id: "ws_peer" as Workspace["id"], name: "Peer" };
beforeEach(() => {
  installFakeEventSource();
  localStorage.clear();
  location.hash = "#/computer";
});
afterEach(cleanup);
function fixture(
  options: {
    role?: SessionRoles["tenantRole"];
    rows?: Workspace[];
    trash?: boolean;
    before?: Workspace[];
  } = {},
) {
  const state = {
    rows: options.rows ?? [workspace],
    trashRows: [archived],
    trashError: false,
    read: undefined as (() => Promise<unknown>) | undefined,
    archive: undefined as (() => Promise<unknown>) | undefined,
    restore: undefined as (() => Promise<unknown>) | undefined,
    trashRead: undefined as (() => Promise<unknown>) | undefined,
    /** Other archived workspaces listed before `trashRows`, 25 a page (#113). */
    before: options.before ?? [],
  };
  const page = (offset: number) => {
    const all = [...state.before, ...state.trashRows];
    return { workspaces: all.slice(offset, offset + 25), bots: [], total: all.length };
  };
  const wire = fakeFetch({
    "GET /api/workspaces": () => (state.read ? state.read() : { workspaces: state.rows }),
    "GET /api/bots": { bots: [] },
    // The first page of archived workspaces (#113).
    "GET /api/trash?offset=0&limit=25": () =>
      state.trashRead
        ? state.trashRead()
        : state.trashError
          ? new Error("Trash unavailable")
          : page(0),
    "GET /api/trash?offset=25&limit=25": () => page(25),
    "POST /api/workspaces/ws_1/archive": async () => {
      if (state.archive) return state.archive();
      state.rows = state.rows.filter((row) => row.id !== workspace.id);
      return { workspace: archived };
    },
    "POST /api/workspaces/ws_1/restore": async () => {
      if (state.restore) return state.restore();
      state.rows = [workspace];
      state.trashRows = [];
      return { workspace };
    },
  });
  const api = createApiClient({ fetch: wire.fetch });
  function Switcher() {
    return <WorkspaceSwitcher scope={useWorkspaceScope(api)} />;
  }
  const view = (trash: boolean, role: SessionRoles["tenantRole"] = options.role ?? "admin") => (
    <SessionRolesProvider roles={{ tenantRole: role, platformMaintainer: false }}>
      <WorkspaceScopeProvider api={api}>
        <Switcher />
        {trash ? <WorkspaceTrashScreen api={api} /> : <ComputerScreen api={api} />}
      </WorkspaceScopeProvider>
    </SessionRolesProvider>
  );
  const rendered = render(view(options.trash ?? false));
  return {
    ...wire,
    state,
    api,
    show: (trash: boolean, role?: SessionRoles["tenantRole"]) =>
      rendered.rerender(view(trash, role)),
  };
}
function archiveEvent() {
  act(() =>
    FakeEventSource.forUrl("/api/events").emit({
      type: "workspace",
      workspaceId: workspace.id,
      workspace: archived,
    }),
  );
}
it("offers archive from Computer and cancellation sends no mutation", async () => {
  const f = fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Move workspace to Trash" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(workspace.name);
  expect(screen.getByRole("dialog")).toHaveTextContent("cancels unfinished runs");
  expect(screen.getByRole("dialog")).toHaveTextContent("denies pending approvals");
  expect(screen.getByRole("dialog")).toHaveTextContent("browser data are retained");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});
it("offers team workspace Trash through the switcher and a real route", async () => {
  fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Workspace: default" }));
  expect(screen.getByRole("menuitem", { name: "Workspace Trash" })).toHaveAttribute(
    "href",
    "#/trash",
  );
  expect(parseRoute("#/trash")).toEqual({ name: "trash" });
});
it("removes the last archived workspace from active selection but keeps Trash reachable", async () => {
  fixture();
  await screen.findByRole("button", { name: "Workspace: default" });
  archiveEvent();
  expect(await screen.findByRole("button", { name: "Workspace: No workspace yet" })).toBeTruthy();
  expect(localStorage.getItem("deskmates.workspace")).toBeNull();
  expect(screen.getByRole("link", { name: "Workspace Trash" })).toBeTruthy();
});
it("selects and persists a remaining workspace after archiving the current one", async () => {
  fixture({ rows: [workspace, peer] });
  await screen.findByRole("button", { name: "Workspace: default" });
  archiveEvent();
  await screen.findByRole("button", { name: "Workspace: Peer" });
  expect(localStorage.getItem("deskmates.workspace")).toBe(peer.id);
});
it("does not resurrect an archived row from an older active-list snapshot", async () => {
  const f = fixture();
  await screen.findByRole("button", { name: "Workspace: default" });
  let resolve!: (value: unknown) => void;
  f.state.read = () =>
    new Promise((done) => {
      resolve = done;
    });
  fireEvent(window, new Event("online"));
  archiveEvent();
  await act(async () => resolve({ workspaces: [workspace] }));
  expect(screen.getByRole("button", { name: "Workspace: No workspace yet" })).toBeTruthy();
});
it("retains an in-flight archive and its cleanup failure after the live archive event, then retries once", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.state.archive = () =>
    new Promise((done) => {
      resolve = done;
    });
  fireEvent.click(await screen.findByRole("button", { name: "Move workspace to Trash" }));
  const confirm = screen.getByRole("button", { name: "Move to Trash" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  archiveEvent();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => resolve(new Error("sandbox stop failed")));
  expect(screen.getByRole("alert")).toHaveTextContent("workspace may already be in Trash");
  expect(screen.getByRole("dialog")).toHaveTextContent("default");
  f.state.archive = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Retry archive" }));
  await waitFor(() => expect(location.hash).toBe("#/trash"));
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2);
});
for (const role of ["owner", "admin"] as const)
  it(`${role} can restore from Organization Trash without replaying work or deleting anything`, async () => {
    const f = fixture({ role, rows: [], trash: true });
    fireEvent.click(await screen.findByRole("button", { name: "Restore default" }));
    await screen.findByText("Restored default.");
    await screen.findByRole("button", { name: "Workspace: default" });
    expect(screen.getByText("No archived workspaces in this Organization.")).toBeTruthy();
    expect(f.calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([
      "/api/workspaces/ws_1/restore",
    ]);
    expect(screen.queryByText("Delete permanently")).toBeNull();
  });
it("separates loading and failed Trash reads from empty, and provides Retry", async () => {
  const f = fixture({ rows: [], trash: true });
  await screen.findByRole("button", { name: "Restore default" });
  f.state.trashError = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("No archived workspaces in this Organization.")).toBeNull();
  let resolve!: (value: unknown) => void;
  f.state.trashRead = () =>
    new Promise((done) => {
      resolve = done;
    });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByText("Loading Workspace Trash…")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  await act(async () => resolve({ workspaces: [], bots: [] }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("No archived workspaces in this Organization.")).toBeTruthy();
});
it("blocks duplicate restore requests, keeps errors actionable, and ignores completion after leaving Trash", async () => {
  const f = fixture({ rows: [], trash: true });
  let resolve!: (value: unknown) => void;
  f.state.restore = () =>
    new Promise((done) => {
      resolve = done;
    });
  const restore = await screen.findByRole("button", { name: "Restore default" });
  fireEvent.click(restore);
  fireEvent.click(restore);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  await act(async () => resolve(new Error("restore failed")));
  expect(screen.getByRole("alert")).toHaveTextContent("restore failed");
  fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
  f.show(false);
  await act(async () => resolve({ workspace }));
  expect(screen.getByRole("button", { name: "Workspace: No workspace yet" })).toBeTruthy();
  expect(location.hash).toBe("#/computer");
});
it("pages archived workspaces and steps back when a restore empties the last page (#113)", async () => {
  const before = Array.from({ length: 25 }, (_, i) => ({
    ...archived,
    id: `ws_old_${i}` as Workspace["id"],
    name: `Old ${i}`,
  }));
  fixture({ rows: [], trash: true, before });
  const pages = await screen.findByRole("navigation", { name: "Trash pages" });
  await waitFor(() => expect(pages).toHaveTextContent("1–25 of 26"));
  fireEvent.click(within(pages).getByRole("button", { name: "Next" }));
  const restore = await screen.findByRole("button", { name: "Restore default" });
  expect(pages).toHaveTextContent("26–26 of 26");
  fireEvent.click(restore);
  // The emptied second page clamps back to the first, now the whole list.
  await screen.findByRole("button", { name: "Restore Old 0" });
  expect(screen.queryByRole("navigation", { name: "Trash pages" })).not.toBeInTheDocument();
});
it("hides management actions from Members and denies direct Trash access without fetching it", async () => {
  const f = fixture({ role: "member" });
  fireEvent.click(await screen.findByRole("button", { name: "Workspace: default" }));
  expect(screen.queryByRole("menuitem", { name: "Workspace Trash" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Move workspace to Trash" })).toBeNull();
  f.show(true);
  expect(screen.getByRole("alert")).toHaveTextContent("Only an Organization Owner or Admin");
  expect(f.calls.some((call) => call.path === "/api/trash")).toBe(false);
});
it("clears Trash content when an authorized viewer becomes a Member", async () => {
  const f = fixture({ trash: true });
  await screen.findByRole("button", { name: "Restore default" });
  f.show(true, "member");
  expect(screen.queryByRole("button", { name: "Restore default" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Only an Organization Owner or Admin");
});
