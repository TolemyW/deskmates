// @vitest-environment jsdom
// T0, ADR-0002 amendment 4 B1: the automatic-approval switch shows the workspace's setting, off by
// default; an Owner or Admin changes it, a Member sees it read-only.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { fakeFetch } from "../../test-support/fixtures.js";
import { AutoApprovalToggle } from "./auto-approval-toggle.js";

afterEach(cleanup);

function renderAs(tenantRole: "admin" | "member", enabled = false) {
  const { fetch, calls } = fakeFetch({
    "GET /api/workspaces/ws_1/auto-approval": {
      autoApproval: { workspaceId: "ws_1", enabled, expiryMinutes: 15 },
    },
    "PUT /api/workspaces/ws_1/auto-approval": (call: {
      body: { enabled?: boolean; expiryMinutes?: number };
    }) => ({
      autoApproval: {
        workspaceId: "ws_1",
        enabled: call.body.enabled ?? enabled,
        expiryMinutes: call.body.expiryMinutes ?? 15,
      },
    }),
  });
  render(
    <SessionRolesProvider roles={{ tenantRole, platformMaintainer: false }}>
      <AutoApprovalToggle api={createApiClient({ fetch })} workspaceId="ws_1" />
    </SessionRolesProvider>,
  );
  return calls;
}

describe("AutoApprovalToggle", () => {
  it("starts off and an Admin turns it on", async () => {
    const calls = renderAs("admin");
    const toggle = await screen.findByRole("switch", { name: /Automatic approval is off/ });
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(toggle);
    await screen.findByRole("switch", { name: /Automatic approval is on/ });
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: true });
  });

  it("lets an Admin change the request expiry (ADR-0002 amendment 3, A7)", async () => {
    const calls = renderAs("admin");
    const field = (await screen.findByRole("spinbutton")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("15"));
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
    const calls = renderAs("member", true);
    const toggle = await screen.findByRole("switch", { name: /Automatic approval is on/ });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
