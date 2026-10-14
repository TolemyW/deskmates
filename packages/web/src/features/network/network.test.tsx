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
  });
  return {
    listWorkspaces: vi.fn(async () => [workspace as Workspace]),
    listNetworkProfiles: vi.fn(async () => ({ profiles: [profile], note: "Reload closes." })),
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
