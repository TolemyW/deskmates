// @vitest-environment jsdom
// People onboarding (ADR-0022 amendment 4, issue #25): Invite by link and Create account are two
// separate, named paths. A created account's initial password is shown once, copied only on an
// explicit click with the result reported, and gone when the panel closes.
import "@testing-library/jest-dom/vitest";
import type { TenantMemberView } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MembersClient } from "../../api/members-client.js";
import { ApiError } from "../../api/types.js";
import { MembersScreen } from "./members.js";

const PASSWORD = "Abcd-Efgh-Jkmn-Pqrs-Tuvw";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const ME: TenantMemberView = {
  userId: "usr_1",
  displayName: "Olive",
  loginName: "olive",
  role: "owner",
  status: "active",
};

function client(): MembersClient {
  return {
    listMembers: vi.fn(async () => [ME]),
    updateMember: vi.fn(async () => {}),
    pageMembers: vi.fn(async () => ({ members: [ME], offset: 0, limit: 25, total: 1 })),
    pageInvitations: vi.fn(async () => ({ invitations: [], offset: 0, limit: 25, total: 0 })),
    createInvitation: vi.fn(async (input) => ({
      invitation: {
        id: "inv_1",
        role: input.role,
        target: input.target,
        createdBy: "user:usr_1",
        createdAt: "2026-10-10T00:00:00.000Z",
        expiresAt: "2026-10-17T00:00:00.000Z",
        status: "open" as const,
      },
      link: "/#/invite/secret-token",
    })),
    revokeInvitation: vi.fn(async () => {}),
    createAccount: vi.fn(async (input) => ({
      member: {
        userId: "usr_9",
        displayName: input.displayName ?? input.loginName,
        loginName: input.loginName,
        role: input.role,
        status: "active" as const,
      },
      loginName: input.loginName,
      initialPassword: PASSWORD,
    })),
    updatePreferences: vi.fn(async () => ({})),
  };
}

function stubClipboard(result: "ok" | "fail") {
  const writeText = vi.fn(async () => {
    if (result === "fail") throw new Error("denied");
  });
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

function renderPeople(people = client()) {
  render(
    <MembersScreen
      client={people}
      tenantRole="owner"
      tenantName="Alpha"
      userId="usr_1"
      ssoProviders={[]}
    />,
  );
  return people;
}

async function createAccount(loginName = "max", displayName: string | null = "Max Member") {
  fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: loginName } });
  if (displayName !== null)
    fireEvent.change(screen.getByLabelText(/^Display name \(optional\)/), {
      target: { value: displayName },
    });
  fireEvent.submit(screen.getByRole("form", { name: "Create account" }));
}

it("creates an account and hands over the login details once", async () => {
  const people = renderPeople();
  const writeText = stubClipboard("ok");
  await createAccount();
  expect(
    await screen.findByRole("heading", { name: "Account created for Max Member" }),
  ).toHaveFocus();
  expect(people.createAccount).toHaveBeenCalledWith({
    loginName: "max",
    displayName: "Max Member",
    role: "member",
  });
  expect(screen.getByText(PASSWORD)).toBeInTheDocument();
  // Nothing is copied until asked.
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Copy login details" }));
  expect(await screen.findByText("Copied.")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith(
    [
      `Sign in: ${window.location.origin}/`,
      "Username: max",
      `Initial password: ${PASSWORD}`,
      "After signing in, open Account settings → Change password.",
    ].join("\n"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText(PASSWORD)).toBeNull();
  expect(document.body.innerHTML).not.toContain(PASSWORD);
  expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
});

it("lets an Admin omit the display name so it defaults to the username", async () => {
  const people = renderPeople();
  await createAccount("max", null);
  expect(people.createAccount).toHaveBeenCalledWith({ loginName: "max", role: "member" });
  expect(
    await screen.findByRole("heading", { name: "Account created for max" }),
  ).toBeInTheDocument();
});

it("says when copying failed so the details can be copied by hand", async () => {
  renderPeople();
  stubClipboard("fail");
  await createAccount();
  fireEvent.click(await screen.findByRole("button", { name: "Copy login details" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Could not copy/);
  expect(screen.getByText(PASSWORD)).toBeInTheDocument();
});

it("keeps the fields and points to Invite by link when the username is taken", async () => {
  const people = client();
  vi.mocked(people.createAccount).mockRejectedValueOnce(
    new ApiError("invalid_transition", "That username is already taken", 409, {
      reason: "login_name_taken",
    }),
  );
  renderPeople(people);
  await createAccount("olive", "Second Olive");
  expect(await screen.findByRole("alert")).toHaveTextContent(/use Invite by link/);
  expect(screen.getByLabelText("Username")).toHaveValue("olive");
  expect(screen.queryByText(PASSWORD)).toBeNull();
});

it("creates an invitation link without a login name and copies it on request", async () => {
  const people = renderPeople();
  const writeText = stubClipboard("ok");
  fireEvent.click(await screen.findByRole("button", { name: "Invite by link" }));
  expect(screen.getByText(/They choose their username and password/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Username")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }));
  await screen.findByRole("heading", { name: "Invitation link ready" });
  expect(people.createInvitation).toHaveBeenCalledWith({
    role: "member",
    target: { kind: "local_signup" },
  });
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy invitation link" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/invite/secret-token`),
  );
  expect(await screen.findByText("Copied.")).toBeInTheDocument();
});

it("offers an SSO invitation only when the team trusts a provider", async () => {
  const people = client();
  render(
    <MembersScreen
      client={people}
      tenantRole="owner"
      tenantName="Alpha"
      userId="usr_1"
      ssoProviders={[{ id: "corp", displayName: "Corp SSO" }]}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Invite by link" }));
  expect(screen.getByText("How they sign in")).toBeInTheDocument();
});
