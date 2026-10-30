// @vitest-environment jsdom
// T0: the Network page's Host resources section (ADR-0006 amendment 5). It lists each finding
// with what, which workspace or none, size, age, why and its one action; a blocked action is
// disabled with the reason; Remove and Re-attach ask first and show the outcome; a low pool
// shows the hint; an unchecked host says so.
import "@testing-library/jest-dom/vitest";
import type { HostResourceFinding, HostResourceReport } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostResourcesSection, formatBytes } from "./host-resources-section.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const orphan: HostResourceFinding = {
  id: "orphan:ws_t2",
  flag: "orphan",
  workspaceId: "ws_t2",
  resources: [
    { kind: "container", name: "deskmates-ws-ws_t2", id: "c1", workspaceId: "ws_t2" },
    { kind: "volume", name: "deskmates-ws_t2-work", id: "v1", workspaceId: "ws_t2" },
  ],
  sizeBytes: 3 * 1024 * 1024,
  createdAt: "2026-10-16T10:00:00Z",
  detail: "no workspace with this id in the database",
  action: "remove",
};
const mismatch: HostResourceFinding = {
  id: "topology_mismatch:ws_ops",
  flag: "topology_mismatch",
  workspaceId: "ws_ops",
  workspaceName: "Ops",
  resources: [{ kind: "container", name: "deskmates-ws-ws_ops", id: "c2", workspaceId: "ws_ops" }],
  detail: "workspace is attached to a legacy or mismatched network",
  action: "reattach",
  blocked: "1 run(s) of this Gateway are live in the workspace",
};

const report = (findings: HostResourceFinding[], status = "ok" as const): HostResourceReport => ({
  checked: true,
  checkedAt: "2026-10-17T00:00:00Z",
  findings,
  healthy: 6,
  pool: {
    status,
    source: "daemon",
    pools: [{ base: "10.200.0.0/16", size: 24 }],
    capacity: 256,
    inUse: 10,
    free: 246,
  },
});

function api(initial: HostResourceReport) {
  return {
    getHostResources: vi.fn(async () => initial),
    removeHostResource: vi.fn(async (findingId: string) => ({
      findingId,
      action: "remove" as const,
      removed: orphan.resources,
      report: report([]),
    })),
    reattachHostResource: vi.fn(async (findingId: string) => ({
      findingId,
      action: "reattach" as const,
      repaired: false,
      problem: "workspace egress-proxy address is missing or stale",
      report: initial,
    })),
  };
}

it("lists each finding with what, workspace, size, age, why and its action", async () => {
  const a = api(report([orphan, mismatch]));
  render(<HostResourcesSection api={a} />);
  const table = await screen.findByRole("table", { name: "Host resources" });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(2);
  const [first, second] = rows as [HTMLElement, HTMLElement];
  expect(within(first).getByText("container deskmates-ws-ws_t2")).toBeInTheDocument();
  expect(within(first).getByText("ws_t2")).toBeInTheDocument();
  expect(within(first).getByText("3.0 MB")).toBeInTheDocument();
  expect(within(first).getByText("No such workspace")).toBeInTheDocument();
  expect(within(first).getByRole("button", { name: "Remove" })).toBeEnabled();
  expect(within(second).getByText("Ops")).toBeInTheDocument();
  expect(within(second).getByText("On the wrong network")).toBeInTheDocument();
  expect(within(second).getByRole("button", { name: "Re-attach" })).toBeDisabled();
  expect(within(second).getByText(/Refused now: 1 run/)).toBeInTheDocument();
  expect(screen.getByText(/246 of 256 networks free \(configured\)/)).toBeInTheDocument();
});

it("shows None for a resource that names no workspace", async () => {
  const legacy: HostResourceFinding = {
    id: "legacy_network:former-egress-outbound",
    flag: "legacy_network",
    resources: [{ kind: "network", name: "former-egress-outbound", id: "n1", role: "legacy" }],
    detail: "a workspace network of a former product name",
    action: "remove",
  };
  render(<HostResourcesSection api={api(report([legacy]))} />);
  const table = await screen.findByRole("table", { name: "Host resources" });
  expect(within(table).getByText("None")).toBeInTheDocument();
  expect(within(table).getByText("Network of a former product name")).toBeInTheDocument();
});

it("asks before Remove, then shows the outcome and the new report", async () => {
  const a = api(report([orphan]));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<HostResourcesSection api={a} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(a.removeHostResource).toHaveBeenCalledWith("orphan:ws_t2"));
  expect(confirm.mock.calls[0]?.[0]).toMatch(/Remove 2 resources from the Docker host/);
  expect(await screen.findByRole("status")).toHaveTextContent("Removed 2 resources.");
  expect(screen.getByText(/Nothing flagged\. 6 resources belong/)).toBeInTheDocument();
});

it("does nothing when Remove is not confirmed", async () => {
  const a = api(report([orphan]));
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<HostResourcesSection api={a} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(a.removeHostResource).not.toHaveBeenCalled();
});

it("says when Re-attach did not repair it", async () => {
  const { blocked: _blocked, ...unblocked } = mismatch;
  const a = api(report([unblocked]));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<HostResourcesSection api={a} />);
  fireEvent.click(await screen.findByRole("button", { name: "Re-attach" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Re-attach did not repair it: workspace egress-proxy address is missing or stale.",
  );
});

it("shows the Gateway's refusal and rereads the report", async () => {
  const a = api(report([orphan]));
  a.removeHostResource.mockRejectedValueOnce(new Error("refused: a run is live in the workspace"));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<HostResourcesSection api={a} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("a run is live");
  expect(a.getHostResources).toHaveBeenCalledTimes(2);
});

it("warns when the pools run low, and says when the host was not checked", async () => {
  const { unmount } = render(<HostResourcesSection api={api(report([], "low" as never))} />);
  expect(await screen.findByText("Running low")).toBeInTheDocument();
  expect(screen.getByText(/Set default-address-pools/)).toBeInTheDocument();
  unmount();
  render(
    <HostResourcesSection
      api={api({
        checked: false,
        checkedAt: "x",
        findings: [],
        healthy: 0,
        error: "Error: daemon down",
      })}
    />,
  );
  expect(await screen.findByText(/Host resources could not be checked/)).toHaveTextContent(
    "Details: Error: daemon down",
  );
});

it("formats sizes", () => {
  expect(formatBytes(undefined)).toBe("-");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
});
