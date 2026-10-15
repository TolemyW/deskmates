// @vitest-environment jsdom
// T0, ADR-0002 amendment 6 D1, D7 and D8: the approval mode offers the three modes and shows the
// workspace's own, an Owner or Admin changes it, a Member sees it read-only; the approve-all
// marker appears only in that mode; a mode decision keeps its actor label.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { actorLabel, approvalEchoLabel } from "../../state/actor-label.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { fakeFetch } from "../../test-support/fixtures.js";
import { ApprovalModeSetting, ApproveAllBadge } from "./approval-mode.js";

afterEach(cleanup);

function routes(mode: string) {
  return {
    "GET /api/workspaces/ws_1/auto-approval": {
      autoApproval: { workspaceId: "ws_1", mode, enabled: mode === "automatic", expiryMinutes: 60 },
    },
    "PUT /api/workspaces/ws_1/auto-approval": (call: {
      body: { mode?: string; expiryMinutes?: number };
    }) => ({
      autoApproval: {
        workspaceId: "ws_1",
        mode: call.body.mode ?? mode,
        enabled: (call.body.mode ?? mode) === "automatic",
        expiryMinutes: call.body.expiryMinutes ?? 60,
      },
    }),
  };
}

function renderAs(tenantRole: "admin" | "member", mode = "automatic") {
  const { fetch, calls } = fakeFetch(routes(mode));
  render(
    <SessionRolesProvider roles={{ tenantRole, platformMaintainer: false }}>
      <ApprovalModeSetting api={createApiClient({ fetch })} workspaceId="ws_1" />
    </SessionRolesProvider>,
  );
  return calls;
}

describe("ApprovalModeSetting", () => {
  it("shows the three modes with the workspace's own selected, and an Admin chooses approve all", async () => {
    const calls = renderAs("admin");
    const automatic = await screen.findByRole("radio", { name: /Automatic review/ });
    await waitFor(() => expect((automatic as HTMLInputElement).checked).toBe(true));
    expect(screen.getByRole("radio", { name: /Ask a person/ })).toBeTruthy();
    expect(screen.queryByTestId("approve-all-badge")).toBeNull();
    await waitFor(() => expect((automatic as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: /Approve all/ }));
    await screen.findByTestId("approve-all-badge");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ mode: "approve_all" });
  });

  it("lets an Admin change the request expiry, 60 minutes by default (D7)", async () => {
    const calls = renderAs("admin");
    const field = (await screen.findByRole("spinbutton")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("60"));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "0" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ expiryMinutes: 30 }),
    );
  });

  it("is read-only for a Member", async () => {
    const calls = renderAs("member", "approve_all");
    const all = await screen.findByRole("radio", { name: /Approve all/ });
    await waitFor(() => expect((all as HTMLInputElement).checked).toBe(true));
    expect((all as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("ApproveAllBadge", () => {
  it("marks a workspace that approves all and nothing else", async () => {
    const all = fakeFetch(routes("approve_all"));
    render(<ApproveAllBadge api={createApiClient({ fetch: all.fetch })} workspaceId="ws_1" />);
    expect((await screen.findByTestId("approve-all-badge")).textContent).toContain("Approve all");
    cleanup();
    const automatic = fakeFetch(routes("automatic"));
    render(
      <ApproveAllBadge api={createApiClient({ fetch: automatic.fetch })} workspaceId="ws_1" />,
    );
    await waitFor(() => expect(automatic.calls.length).toBe(1));
    expect(screen.queryByTestId("approve-all-badge")).toBeNull();
  });

  it("keeps mode:approve_all as the decider label (D8)", () => {
    expect(actorLabel("mode:approve_all")).toBe("mode:approve_all");
    expect(approvalEchoLabel("Approved by mode:approve_all", (actor) => `x${actor}`)).toBe(
      "Approved by mode:approve_all",
    );
  });
});
