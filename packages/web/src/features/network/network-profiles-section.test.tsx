// @vitest-environment jsdom
// T0: the workspace detail page's Network profiles section (ADR-0027 amendment 1 decisions 12 and
// 13): an Admin sees the profiles available there, selects one and sets the open-internet switch;
// a Member and an archived workspace show nothing and ask the Gateway nothing.
import "@testing-library/jest-dom/vitest";
import type {
  NetworkProfile,
  WorkspaceDirectoryEntry,
  WorkspaceId,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { NetworkProfilesSection } from "./network-profiles-section.js";

afterEach(cleanup);

const profile: NetworkProfile = {
  id: "netp_1",
  name: "Owen's service",
  description: "",
  rules: [{ kind: "subnet", cidr: "10.88.30.0/24", schemes: ["http"], ports: [23001] }],
  revision: 1,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  updatedBy: "user:usr_owen",
  ownerUserId: "usr_owen",
};

const entry = (
  myRole: WorkspaceDirectoryEntry["myRole"],
  extra: Partial<WorkspaceDirectoryEntry> = {},
): WorkspaceDirectoryEntry => ({
  id: "ws_1" as WorkspaceId,
  name: "W",
  myRole,
  pinned: false,
  botCount: 1,
  activeRuns: null,
  lastActivityAt: "2026-10-14T09:00:00.000Z",
  createdAt: "2026-10-14T09:00:00.000Z",
  openInternet: true,
  ...extra,
});

function client() {
  const calls: string[] = [];
  let view: WorkspaceNetworkView = {
    workspaceId: "ws_1",
    trustedTest: false,
    selections: [],
    grants: [],
    openInternet: true,
    profilesOnOpenInternet: true,
    available: [profile],
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let answer: unknown = view;
    if (path.endsWith("/network-settings")) {
      view = { ...view, profilesOnOpenInternet: body.profilesOnOpenInternet };
      answer = { network: view };
    } else if (path.endsWith("/network-profiles")) {
      view = {
        ...view,
        trustedTest: true,
        selections: [
          { profileId: "netp_1", profileName: profile.name, selectedAt: "x", selectedBy: "y" },
        ],
        grants: profile.rules,
      };
      answer = {
        selections: view.selections,
        network: view,
        publication: { workspaceId: "ws_1", status: "applied" },
      };
    }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

it("lets an Admin select an available profile and set the open-internet switch", async () => {
  const { api, calls } = client();
  render(<NetworkProfilesSection api={api} entry={entry("admin")} onChanged={() => {}} />);
  expect(await screen.findByText("Internal network access")).toBeInTheDocument();
  expect(await screen.findByText(/This workspace browses the open internet/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /Owen's service/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByText("Trusted-test workspace")).toBeInTheDocument();
  expect(calls).toContain("PUT /api/workspaces/ws_1/network-profiles");
  const toggle = screen.getByRole("checkbox", {
    name: "Allow network profiles while this workspace browses the open internet (*)",
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(calls).toContain("PUT /api/workspaces/ws_1/network-settings");
});

it("shows nothing to a Member or for an archived workspace", () => {
  const { api, calls } = client();
  const member = render(
    <NetworkProfilesSection api={api} entry={entry("member")} onChanged={() => {}} />,
  );
  expect(member.container.textContent).toBe("");
  cleanup();
  const archived = render(
    <NetworkProfilesSection
      api={api}
      entry={entry("owner", { archivedAt: "2026-10-14T10:00:00.000Z" })}
      onChanged={() => {}}
    />,
  );
  expect(archived.container.textContent).toBe("");
  expect(calls).toEqual([]);
});

it("keeps unsubmitted profile choices when the separate internet switch is saved", async () => {
  const { api, calls } = client();
  render(<NetworkProfilesSection api={api} entry={entry("admin")} onChanged={() => {}} />);
  const choice = await screen.findByRole("checkbox", { name: /Owen's service/ });
  fireEvent.click(choice);
  const toggle = screen.getByRole("checkbox", { name: /Allow network profiles while/ });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(choice).toBeChecked();
  expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  expect(calls.some((call) => call.startsWith("PUT") && call.endsWith("/network-profiles"))).toBe(
    false,
  );
});

it("recovers a failed network-profile read without changing a grant", async () => {
  const { api, calls } = client();
  vi.spyOn(api, "getWorkspaceNetwork").mockRejectedValueOnce(new Error("Read unavailable"));
  render(<NetworkProfilesSection api={api} entry={entry("admin")} onChanged={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Read unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("checkbox", { name: /Owen's service/ })).not.toBeChecked();
  expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
});
