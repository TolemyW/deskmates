import type { TenantMemberView } from "@deskmates/contracts";
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MembersClient } from "../api/members-client.js";
import { ActorDirectoryProvider } from "./actor-directory.js";
import { SessionRolesProvider, useActorLabel } from "./session-roles.js";
const selected = vi.hoisted(() => ({ id: "workspace-a" }));
vi.mock("./workspace-scope.js", () => ({
  useWorkspaceScope: () => ({ current: selected }),
  useSelectedWorkspaceId: () => selected.id,
  useWorkspaceForCalls: () => ({ workspaceId: selected.id, pending: false }),
}));
const person = (
  userId: string,
  displayName: string,
  status: "active" | "removed" = "active",
): TenantMemberView => ({ userId, displayName, status, role: "member", loginName: null });
afterEach(() => {
  cleanup();
  selected.id = "workspace-a";
});
function Labels() {
  const label = useActorLabel();
  return (
    <>
      {[
        "human:user:self",
        "human:user:other",
        "user:duplicate",
        "bot:other",
        "reviewer:other",
        "system",
        "user:foreign",
      ].map((actor) => (
        <p key={actor} data-testid={actor}>
          {label(actor)}
        </p>
      ))}
    </>
  );
}
function view(members: MembersClient, allowed = true) {
  return (
    <SessionRolesProvider
      roles={{ tenantRole: allowed ? "admin" : "member", platformMaintainer: false }}
      actorId="user:self"
      displayName="Alex"
    >
      <ActorDirectoryProvider members={members} allowed={allowed}>
        <Labels />
      </ActorDirectoryProvider>
    </SessionRolesProvider>
  );
}
it("resolves exact authorized humans, including duplicate names, without changing other actor types", async () => {
  const listMembers = vi
    .fn()
    .mockResolvedValue([person("other", "Alex"), person("duplicate", "Alex")]);
  render(view({ listMembers } as unknown as MembersClient));
  await waitFor(() => expect(screen.getByTestId("human:user:other").textContent).toBe("Alex"));
  expect(screen.getByTestId("user:duplicate").textContent).toBe("Alex");
  for (const actor of ["bot:other", "reviewer:other", "system", "user:foreign"])
    expect(screen.getByTestId(actor).textContent).toBe(actor);
});
it("never queries the directory for a Member and drops names immediately when permission is lost", async () => {
  const listMembers = vi.fn().mockResolvedValue([person("other", "Other person")]);
  const members = { listMembers } as unknown as MembersClient;
  const { rerender } = render(view(members, false));
  expect(listMembers).not.toHaveBeenCalled();
  rerender(view(members));
  await screen.findByText("Other person");
  rerender(view(members, false));
  expect(screen.getByTestId("human:user:other").textContent).toBe("human:user:other");
});
it("refreshes renamed/deleted actors and drops stale names on denied reads", async () => {
  const listMembers = vi.fn().mockResolvedValue([person("other", "Original")]);
  render(view({ listMembers } as unknown as MembersClient));
  await screen.findByText("Original");
  listMembers.mockResolvedValue([person("other", "Renamed")]);
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("Renamed");
  listMembers.mockResolvedValue([person("other", "Removed", "removed")]);
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() =>
    expect(screen.getByTestId("human:user:other").textContent).toBe("human:user:other"),
  );
  listMembers.mockRejectedValue(new Error("403"));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(4));
  expect(screen.getByTestId("human:user:other").textContent).toBe("human:user:other");
});
it("does not reveal an old workspace or tenant response after switching", async () => {
  let finish!: (rows: TenantMemberView[]) => void;
  const old = {
    listMembers: vi.fn(
      () =>
        new Promise<TenantMemberView[]>((resolve) => {
          finish = resolve;
        }),
    ),
  } as unknown as MembersClient;
  const fresh = { listMembers: vi.fn().mockResolvedValue([]) } as unknown as MembersClient;
  const { rerender } = render(view(old));
  selected.id = "workspace-b";
  rerender(view(fresh));
  await act(async () => finish([person("other", "Foreign old name")]));
  expect(screen.queryByText("Foreign old name")).toBeNull();
  expect(screen.getByTestId("human:user:other").textContent).toBe("human:user:other");
});
it("keeps the current names on screen while a refresh is in flight", async () => {
  const listMembers = vi.fn().mockResolvedValue([person("other", "Original")]);
  render(view({ listMembers } as unknown as MembersClient));
  await screen.findByText("Original");
  let finish!: (rows: TenantMemberView[]) => void;
  listMembers.mockImplementation(
    () =>
      new Promise<TenantMemberView[]>((resolve) => {
        finish = resolve;
      }),
  );
  act(() => window.dispatchEvent(new Event("focus")));
  expect(screen.getByTestId("human:user:other").textContent).toBe("Original");
  await act(async () => finish([person("other", "Renamed")]));
  expect(screen.getByTestId("human:user:other").textContent).toBe("Renamed");
});
it("coalesces overlapping refreshes and reads the newly selected workspace's people on a switch", async () => {
  let finish!: (rows: TenantMemberView[]) => void;
  const listMembers = vi.fn(
    (_workspaceId?: string) =>
      new Promise<TenantMemberView[]>((resolve) => {
        finish = resolve;
      }),
  );
  const members = { listMembers } as unknown as MembersClient;
  const { rerender } = render(view(members));
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(listMembers).toHaveBeenCalledTimes(1);
  expect(listMembers).toHaveBeenLastCalledWith("workspace-a");
  await act(async () => finish([person("other", "Other person")]));
  // One follow-up covers every event that arrived during the first request.
  expect(listMembers).toHaveBeenCalledTimes(2);
  await act(async () => finish([person("other", "Other person")]));
  expect(screen.getByTestId("human:user:other").textContent).toBe("Other person");
  expect(listMembers).toHaveBeenCalledTimes(2);
  // People are per workspace (ADR-0022 amendment 6 W9): a switch reads the new workspace's.
  selected.id = "workspace-b";
  rerender(view(members));
  expect(listMembers).toHaveBeenCalledTimes(3);
  expect(listMembers).toHaveBeenLastCalledWith("workspace-b");
});
