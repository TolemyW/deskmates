// @vitest-environment jsdom
// T0: the network profiles screen leads with the workspace at hand (its selection, with expired
// profiles shown but not selectable, applied as one change), lists every profile in a table,
// edits one in the structured form or as JSON, and reports each publication outcome; a refusal
// from the Gateway is shown as it came.
import "@testing-library/jest-dom/vitest";
import type {
  NetworkProfile,
  Workspace,
  WorkspaceId,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { workspace } from "../../test-support/fixtures.js";
import { NetworkScreen, ruleSummary } from "./network.js";

afterEach(cleanup);

const profile: NetworkProfile = {
  id: "netp_1",
  name: "VendorDB test environment",
  description: "",
  rules: [{ kind: "subnet", cidr: "10.88.30.0/24", schemes: ["http"], ports: [23001] }],
  revision: 3,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  updatedBy: "user:root",
};

const expired: NetworkProfile = {
  ...profile,
  id: "netp_old",
  name: "Old lab",
  expiresAt: "2026-01-01T00:00:00Z",
};

function fakeApi(overrides: Record<string, unknown> = {}, available: NetworkProfile[] = [profile]) {
  const view = (trusted: boolean): WorkspaceNetworkView => ({
    workspaceId: workspace.id,
    trustedTest: trusted,
    selections: trusted
      ? [{ profileId: "netp_1", profileName: profile.name, selectedAt: "x", selectedBy: "y" }]
      : [],
    grants: trusted ? profile.rules : [],
    openInternet: false,
    profilesOnOpenInternet: true,
    available,
  });
  return {
    listWorkspaces: vi.fn(async () => [workspace as Workspace]),
    listNetworkProfiles: vi.fn(async () => ({
      profiles: available,
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
    getHostResources: vi.fn(async () => ({
      checked: true,
      checkedAt: "2026-10-17T00:00:00Z",
      findings: [],
      healthy: 0,
    })),
    reattachHostResource: vi.fn(),
    removeHostResource: vi.fn(),
    setWorkspaceNetworkSettings: vi.fn(async (_id: WorkspaceId, allowed: boolean) => ({
      network: { ...view(false), profilesOnOpenInternet: allowed },
    })),
    createNetworkProfile: vi.fn(async (_input: unknown) => profile),
    replaceNetworkProfile: vi.fn(),
    deleteNetworkProfile: vi.fn(),
    ...overrides,
  };
}

it("summarizes host and subnet rules", () => {
  expect(ruleSummary(profile.rules[0] as NetworkProfile["rules"][number])).toBe(
    "http 10.88.30.0/24 :23001",
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

it("selects a profile for the workspace at hand and shows the acknowledged outcome", async () => {
  const api = fakeApi();
  render(<NetworkScreen api={api as never} />);
  expect(
    await screen.findByRole("heading", {
      name: `What ${workspace.name} can reach on the internal network`,
    }),
  ).toBeInTheDocument();
  expect(await screen.findByText("No internal network access")).toBeInTheDocument();
  expect(screen.getAllByText("Reload closes.").length).toBeGreaterThan(0);
  const apply = screen.getByRole("button", { name: "Apply" });
  // Nothing changed yet, so there is nothing to apply.
  expect(apply).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /VendorDB test environment/ }));
  fireEvent.click(apply);
  await waitFor(() =>
    expect(api.setWorkspaceNetworkProfiles).toHaveBeenCalledWith(workspace.id, [
      { profileId: "netp_1" },
    ]),
  );
  expect(await screen.findByText("Trusted-test workspace")).toBeInTheDocument();
  expect(screen.getByText(`${workspace.id}: applied`)).toBeInTheDocument();
});

it("sends a per-selection end as an instant only for a selection that has one", async () => {
  const api = fakeApi();
  render(<NetworkScreen api={api as never} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /VendorDB test environment/ }));
  fireEvent.change(screen.getByLabelText("Ends on (optional)"), {
    target: { value: "2026-10-31T08:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(api.setWorkspaceNetworkProfiles).toHaveBeenCalledWith(workspace.id, [
      { profileId: "netp_1", expiresAt: new Date("2026-10-31T08:00").toISOString() },
    ]),
  );
});

it("shows an expired profile dimmed, not selectable, in the selection and the table", async () => {
  const api = fakeApi({}, [profile, expired]);
  render(<NetworkScreen api={api as never} />);
  const choice = await screen.findByRole("checkbox", { name: /Old lab/ });
  expect(choice).toBeDisabled();
  expect(choice.closest("li")?.getAttribute("data-expired")).toBe("true");
  const table = screen.getByRole("table", { name: "All profiles" });
  const row = within(table).getByText("Old lab").closest("tr");
  expect(row?.getAttribute("data-expired")).toBe("true");
  expect(within(row as HTMLElement).getByText("Expired")).toBeInTheDocument();
  expect(within(table).getByText("Never expires")).toBeInTheDocument();
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
    target: { value: "http://10.88.30.24:23001/health" },
  });
  fireEvent.click(check);
  expect(await screen.findByText("Failed at: TCP")).toBeInTheDocument();
  expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
  expect(preflightWorkspaceNetwork).toHaveBeenCalledWith(
    workspace.id,
    "http://10.88.30.24:23001/health",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "URL to check" }), {
    target: { value: "http://10.88.30.24:23001/other" },
  });
  expect(screen.queryByText("Failed at: TCP")).toBeNull();
  expect(preflightWorkspaceNetwork).toHaveBeenCalledTimes(1);
});

it("sums up internal network targets inside a Docker network in one line, marks the row, and is silent without one", async () => {
  const api = fakeApi({
    getNetworkOverlaps: vi.fn(async () => ({
      checked: true,
      networks: [{ name: "vendordb-demo-net", cidr: "172.18.0.0/16" }],
      overlaps: [
        {
          source: "profile",
          label: "VendorDB test environment",
          cidr: "10.88.30.0/24",
          network: "vendordb-demo-net",
          networkCidr: "172.18.0.0/16",
        },
      ],
    })),
  });
  render(<NetworkScreen api={api as never} />);
  expect(
    await screen.findByText(
      "1 internal network target sits inside a Docker network on this host and cannot be reached.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "10.88.30.0/24 (VendorDB test environment) overlaps vendordb-demo-net (172.18.0.0/16)",
    ),
  ).toBeInTheDocument();
  const table = screen.getByRole("table", { name: "All profiles" });
  expect(within(table).getByTitle(/Inside a Docker network/)).toBeInTheDocument();
  cleanup();
  render(<NetworkScreen api={fakeApi() as never} />);
  await screen.findByRole("table", { name: "All profiles" });
  expect(screen.queryByText(/inside a Docker network/)).toBeNull();
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

it("creates a profile from the structured form, with a week's expiry", async () => {
  const api = fakeApi();
  render(<NetworkScreen api={api as never} />);
  fireEvent.click(await screen.findByRole("button", { name: "New profile" }));
  const form = screen.getByRole("form", { name: "New profile" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Lab console" } });
  fireEvent.change(within(form).getByLabelText("Target kind"), { target: { value: "host" } });
  fireEvent.change(within(form).getByLabelText("Host name"), {
    target: { value: "console.lab.test" },
  });
  fireEvent.change(within(form).getByLabelText("IPv4 address"), {
    target: { value: "10.0.0.5" },
  });
  fireEvent.click(within(form).getByLabelText("https"));
  fireEvent.change(within(form).getByLabelText("Ports"), { target: { value: "443, 8443" } });
  fireEvent.click(within(form).getByLabelText("In 7 days"));
  const before = Date.now();
  fireEvent.click(within(form).getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(api.createNetworkProfile).toHaveBeenCalled());
  const input = api.createNetworkProfile.mock.calls[0]?.[0] as {
    name: string;
    rules: unknown;
    expiresAt?: string;
  };
  expect(input.name).toBe("Lab console");
  expect(input.rules).toEqual([
    {
      kind: "host",
      hostname: "console.lab.test",
      address: "10.0.0.5",
      schemes: ["http", "https"],
      ports: [443, 8443],
    },
  ]);
  const expiresAt = Date.parse(input.expiresAt ?? "");
  expect(expiresAt - before).toBeGreaterThanOrEqual(7 * 24 * 3_600_000 - 1000);
  expect(expiresAt - before).toBeLessThan(7 * 24 * 3_600_000 + 60_000);
});

it("names a bad row before asking the Gateway, and switches to JSON and back", async () => {
  const api = fakeApi();
  render(<NetworkScreen api={api as never} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = screen.getByRole("form", { name: "Edit profile" });
  fireEvent.change(within(form).getByLabelText("Subnet (CIDR)"), {
    target: { value: "8.8.8.0/24" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Save profile" }));
  expect(await within(form).findByRole("alert")).toHaveTextContent(/RFC1918/);
  expect(api.replaceNetworkProfile).not.toHaveBeenCalled();

  fireEvent.click(within(form).getByRole("button", { name: "Advanced: edit as JSON" }));
  const json = within(form).getByLabelText("Rules as JSON") as HTMLTextAreaElement;
  expect(JSON.parse(json.value)).toEqual([
    { kind: "subnet", cidr: "8.8.8.0/24", schemes: ["http"], ports: [23001] },
  ]);
  fireEvent.change(json, { target: { value: "[{nope" } });
  fireEvent.click(within(form).getByRole("button", { name: "Back to the form" }));
  expect(await within(form).findByRole("alert")).toHaveTextContent(/not a list of rules/);
  fireEvent.change(json, {
    target: {
      value: JSON.stringify([
        { kind: "subnet", cidr: "10.88.31.0/24", schemes: ["https"], ports: [8443] },
      ]),
    },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Back to the form" }));
  expect(within(form).getByLabelText("Subnet (CIDR)")).toHaveValue("10.88.31.0/24");
  expect(within(form).getByLabelText("https")).toBeChecked();
  expect(within(form).getByLabelText("Ports")).toHaveValue("8443");
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
  const table = await screen.findByRole("table", { name: "All profiles" });
  expect(within(table).getByText("Owen's service")).toBeInTheDocument();
  expect(within(table).getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  expect(within(table).getByText("Workspaces of its Owner")).toBeInTheDocument();
  expect(within(table).getByText("All workspaces")).toBeInTheDocument();
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

it("keeps a failed profile list out of a permanent loading state", async () => {
  const api = fakeApi();
  api.listNetworkProfiles.mockRejectedValueOnce(new Error("Profiles unavailable"));
  render(<NetworkScreen api={api as never} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Profiles unavailable");
  expect(
    within(screen.getByRole("region", { name: "All profiles" })).queryByText("Loading…"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("table", { name: "All profiles" })).toBeInTheDocument();
});

it("keeps a pending profile edit intact and restores focus after discarding a refused save", async () => {
  let rejectSave!: (reason: Error) => void;
  const api = fakeApi({
    replaceNetworkProfile: vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    ),
  });
  render(<NetworkScreen api={api as never} />);
  const edit = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(edit);
  const form = screen.getByRole("form", { name: "Edit profile" });
  const name = within(form).getByLabelText("Name");
  expect(name).toHaveFocus();
  expect(edit).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  fireEvent.change(name, { target: { value: "Renamed lab" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save profile" }));
  expect(name).toBeDisabled();
  expect(within(form).getByLabelText("Subnet (CIDR)")).toBeDisabled();
  expect(within(form).getByLabelText("In 7 days")).toBeDisabled();
  expect(within(form).getByRole("button", { name: "Advanced: edit as JSON" })).toBeDisabled();
  expect(within(form).getByRole("button", { name: "Cancel" })).toBeDisabled();
  rejectSave(new Error("Profile changed on the server"));
  await screen.findByText("Profile changed on the server");
  expect(name).toHaveValue("Renamed lab");
  expect(name).toBeEnabled();
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(edit).toHaveFocus();
  expect(screen.queryByText("Profile changed on the server")).not.toBeInTheDocument();
  fireEvent.click(edit);
  expect(screen.getByLabelText("Name")).toHaveValue(profile.name);
});
