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
    "GET /api/workspaces/ws_1/auto-approval": { autoApproval: { workspaceId: "ws_1", enabled } },
    "PUT /api/workspaces/ws_1/auto-approval": (call: { body: { enabled: boolean } }) => ({
      autoApproval: { workspaceId: "ws_1", enabled: call.body.enabled },
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

  it("is read-only for a Member", async () => {
    const calls = renderAs("member", true);
    const toggle = await screen.findByRole("switch", { name: /Automatic approval is on/ });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
