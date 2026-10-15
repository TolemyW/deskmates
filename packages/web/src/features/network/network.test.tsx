// @vitest-environment jsdom
// T0: the network profiles screen lists profiles, shows a workspace's grants, saves a selection
// and reports each publication outcome; a refusal from the Gateway is shown as it came.
import "@testing-library/jest-dom/vitest";
import type {
  NetworkProfile,
  Workspace,
  WorkspaceId,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { workspace } from "../../test-support/fixtures.js";
import { NetworkScreen, ruleSummary } from "./network.js";

afterEach(cleanup);

const profile: NetworkProfile = {
  id: "netp_1",
  name: "VendorDB test environment",
  description: "",
  rules: [{ kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] }],
  revision: 3,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  updatedBy: "user:root",
};

function fakeApi(overrides: Record<string, unknown> = {}) {
  const view = (trusted: boolean): WorkspaceNetworkView => ({
    workspaceId: workspace.id,
    trustedTest: trusted,
    selections: trusted
      ? [{ profileId: "netp_1", profileName: profile.name, selectedAt: "x", selectedBy: "y" }]
      : [],
    grants: trusted ? profile.rules : [],
    openInternet: false,
    profilesOnOpenInternet: true,
    available: [profile],
  });
  return {
    listWorkspaces: vi.fn(async () => [workspace as Workspace]),
    listNetworkProfiles: vi.fn(async () => ({
      profiles: [profile],
      note: "Reload closes.",
      manageAll: true,
    })),
    getWorkspaceNetwork: vi.fn(async (_id: WorkspaceId) => view(false)),
    setWorkspaceNetworkProfiles: vi.fn(async () => ({
      selections: view(true).selections,
      network: view(true),
      publication: {
        workspaceId: workspace.id,
        status: "applied" as const,
        policyHash: "ab".repeat(32),
      },
    })),
    getNetworkOverlaps: vi.fn(async () => ({ checked: true, networks: [], overlaps: [] })),
    setWorkspaceNetworkSettings: vi.fn(async (_id: WorkspaceId, allowed: boolean) => ({
      network: { ...view(false), profilesOnOpenInternet: allowed },
    })),
    createNetworkProfile: vi.fn(),
    replaceNetworkProfile: vi.fn(),
    deleteNetworkProfile: vi.fn(),
    ...overrides,
  };
}

it("summarizes host and subnet rules", () => {
  expect(ruleSummary(profile.rules[0] as NetworkProfile["rules"][number])).toBe(
    "http 10.20.30.0/24 :23001",
  );
  expect(
    ruleSummary({
      kind: "host",
      hostname: "console.lab.test",
      address: "10.0.0.5",
      schemes: ["https"],
      ports: [443, 8443],
    }),
  ).toBe("https console.lab.test→10.0.0.5 :443,8443");
});

it("selects a profile for a workspace and shows the acknowledged outcome", async () => {
  const api = fakeApi();
  render(<NetworkScreen api={api as never} />);
  expect(await screen.findByText("VendorDB test environment")).toBeInTheDocument();
  expect(screen.getAllByText("Reload closes.").length).toBeGreaterThan(0);
  expect(await screen.findByText("No LAN access")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "VendorDB test environment" }));
  fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
  await waitFor(() =>
    expect(api.setWorkspaceNetworkProfiles).toHaveBeenCalledWith(workspace.id, [
      { profileId: "netp_1" },
    ]),
  );
  expect(await screen.findByText("Trusted-test workspace")).toBeInTheDocument();
  expect(screen.getByText(`${workspace.id}: applied`)).toBeInTheDocument();
});

it("sends a per-selection expiry only for a selection that has one", async () => {
  const api = fakeApi();
  render(<NetworkScreen api={api as never} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "VendorDB test environment" }));
  const expiry = screen.getByRole("textbox", { name: "Selection expires at (ISO UTC, optional)" });
  fireEvent.change(expiry, { target: { value: " 2026-10-31T00:00:00Z " } });
  fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
  await waitFor(() =>
    expect(api.setWorkspaceNetworkProfiles).toHaveBeenCalledWith(workspace.id, [
      { profileId: "netp_1", expiresAt: "2026-10-31T00:00:00Z" },
    ]),
  );
});

it("runs a preflight for the workspace and names the failing layer", async () => {
  const preflightWorkspaceNetwork = vi.fn(async (_id: WorkspaceId, url: string) => ({
    url,
    ok: false,
    admittedBy: "grant",
    failedLayer: "tcp",
    layers: [
      { layer: "policy", ok: true, detail: "admitted by grant" },
      { layer: "tcp", ok: false, detail: "ECONNREFUSED" },
    ],
  }));
  const api = fakeApi({ preflightWorkspaceNetwork });
  render(<NetworkScreen api={api as never} />);
  const check = await screen.findByRole("button", { name: "Check" });
  expect(check).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "URL to check" }), {
    target: { value: "http://10.20.30.24:23001/health" },
  });
  fireEvent.click(check);
  expect(await screen.findByText("Failed at: TCP")).toBeInTheDocument();
  expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
  expect(preflightWorkspaceNetwork).toHaveBeenCalledWith(
    workspace.id,
    "http://10.20.30.24:23001/health",
  );
});

it("warns about a LAN target inside a Docker network and is silent without one", async () => {
  const api = fakeApi({
    getNetworkOverlaps: vi.fn(async () => ({
      checked: true,
      networks: [{ name: "vendordb-demo-net", cidr: "172.18.0.0/16" }],
      overlaps: [
        {
          source: "profile",
          label: "VendorDB test environment",
          cidr: "10.20.30.0/24",
          network: "vendordb-demo-net",
          networkCidr: "172.18.0.0/16",
        },
      ],
    })),
  });
  render(<NetworkScreen api={api as never} />);
  expect(await screen.findByText("LAN targets inside a Docker network")).toBeInTheDocument();
  expect(
    screen.getByText(
      "10.20.30.0/24 (VendorDB test environment) overlaps vendordb-demo-net (172.18.0.0/16)",
    ),
  ).toBeInTheDocument();
  cleanup();
  render(<NetworkScreen api={fakeApi() as never} />);
  await screen.findByText("VendorDB test environment");
  expect(screen.queryByText("LAN targets inside a Docker network")).toBeNull();
});

it("shows the Gateway's refusal and sends the revision with an edit", async () => {
  const api = fakeApi({
    replaceNetworkProfile: vi.fn(async () => {
      throw new Error("only the administrator account may do this");
    }),
  });
  render(<NetworkScreen api={api as never} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  expect(await screen.findByText("only the administrator account may do this")).toBeInTheDocument();
  expect(api.replaceNetworkProfile).toHaveBeenCalledWith(
    "netp_1",
    expect.objectContaining({ name: profile.name, rules: profile.rules }),
    3,
  );
});

it("an Owner edits only their own profiles and sees no overlap report (decision 12)", async () => {
  const theirs = { ...profile, id: "netp_2", name: "Owen's service", ownerUserId: "usr_owen" };
  const api = fakeApi({
    listNetworkProfiles: vi.fn(async () => ({
      profiles: [
        { ...profile, editable: false },
        { ...theirs, editable: true },
      ],
      manageAll: false,
    })),
  });
  render(<NetworkScreen api={api as never} />);
  expect(await screen.findByText("Owen's service")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  expect(screen.getByText("Workspaces of its Owner")).toBeInTheDocument();
  expect(screen.getByText("All workspaces")).toBeInTheDocument();
  expect(api.getNetworkOverlaps).not.toHaveBeenCalled();
});

it("turns the open-internet switch off and on (decision 13)", async () => {
  const api = fakeApi();
  render(<NetworkScreen api={api as never} />);
  const toggle = await screen.findByRole("checkbox", {
    name: "Allow network profiles while this workspace browses the open internet (*)",
  });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(api.setWorkspaceNetworkSettings).toHaveBeenCalledWith(workspace.id, false),
  );
  await waitFor(() => expect(toggle).not.toBeChecked());
});
