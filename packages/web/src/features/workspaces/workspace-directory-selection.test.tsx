// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { WorkspaceDirectoryEntry, WorkspaceId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "../../state/workspace-scope.js";
import { fakeFetch, workspace, workspaceView } from "../../test-support/fixtures.js";
import { WorkspaceSwitcher } from "./workspace-switcher.js";

const fresh = { ...workspace, id: "ws_fresh" as WorkspaceId, name: "New API workspace" };
const other = { ...workspace, id: "ws_other" as WorkspaceId, name: "Other known workspace" };
const entry: WorkspaceDirectoryEntry = {
  id: fresh.id,
  name: fresh.name,
  myRole: "owner",
  pinned: false,
  botCount: 0,
  activeRuns: 0,
  lastActivityAt: fresh.createdAt,
  createdAt: fresh.createdAt,
  openInternet: false,
};

beforeEach(() => {
  localStorage.removeItem("deskmates.workspace");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const wire = fakeFetch({
    "GET /api/workspaces": { workspaces: [workspace, other] },
    [`GET /api/workspaces/${fresh.id}`]: workspaceView({ workspace: fresh }),
  });
  const api = createApiClient({ fetch: wire.fetch });
  vi.spyOn(api, "listWorkspaceDirectory").mockImplementation(async (q) => ({
    workspaces: q?.filter === "pinned" ? [] : [entry],
    offset: 0,
    limit: 5,
    total: 1,
  }));
  return api;
}
function Probe({ api }: { api: ApiClient }) {
  const scope = useWorkspaceScope(api);
  return (
    <>
      <WorkspaceSwitcher scope={scope} />
      <output data-testid="selected-workspace">{scope.current?.name}</output>
      <button type="button" onClick={() => scope.select(other.id)}>
        Choose known workspace
      </button>
    </>
  );
}
function mount(api: ApiClient) {
  return render(
    <WorkspaceScopeProvider api={api} initialWorkspaceId={workspace.id}>
      <Probe api={api} />
    </WorkspaceScopeProvider>,
  );
}
async function chooseFresh() {
  fireEvent.click(await screen.findByRole("button", { name: `Workspace: ${workspace.name}` }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /New API workspace/ }));
}

it("selects a newer authorized directory row without reloading the page", async () => {
  const api = setup();
  const get = vi.spyOn(api, "getWorkspace");
  mount(api);
  await chooseFresh();
  await waitFor(() =>
    expect(screen.getByTestId("selected-workspace")).toHaveTextContent(fresh.name),
  );
  expect(get).toHaveBeenCalledWith(fresh.id);
  expect(localStorage.getItem("deskmates.workspace")).toBe(fresh.id);
});

it("does not let a slow directory selection override a later known selection", async () => {
  const api = setup();
  let resolve!: (value: ReturnType<typeof workspaceView>) => void;
  vi.spyOn(api, "getWorkspace").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mount(api);
  await chooseFresh();
  fireEvent.click(screen.getByRole("button", { name: "Choose known workspace" }));
  await act(async () => resolve(workspaceView({ workspace: fresh })));
  expect(screen.getByTestId("selected-workspace")).toHaveTextContent(other.name);
  expect(localStorage.getItem("deskmates.workspace")).toBe(other.id);
});

it("keeps the old selection and exposes a refused directory read", async () => {
  const api = setup();
  vi.spyOn(api, "getWorkspace").mockRejectedValue(
    new ApiError("forbidden", "This workspace is unavailable", 403),
  );
  mount(api);
  await chooseFresh();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: `Workspace: ${workspace.name}` }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This workspace is unavailable");
  expect(screen.getByTestId("selected-workspace")).toHaveTextContent(workspace.name);
});
