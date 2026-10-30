// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { TenantRole } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { SessionRolesProvider } from "../state/session-roles.js";
import {
  WS_ID,
  browserLock,
  fakeFetch,
  installFakeEventSource,
  workspaceView,
} from "../test-support/fixtures.js";
import { BrowserHoldBanner } from "./browser-hold-banner.js";

function view(role: TenantRole, heldByMe = false) {
  const wire = fakeFetch({
    "GET /api/workspaces/ws_1": workspaceView({
      browserLock: browserLock(),
      browserLockHeldByMe: heldByMe,
    }),
    "POST /api/workspaces/ws_1/handback": { released: true },
  });
  render(
    <SessionRolesProvider
      roles={{
        tenantRole: role,
        platformMaintainer: false,
        workspaceRoles: { [WS_ID]: role },
      }}
    >
      <BrowserHoldBanner api={createApiClient({ fetch: wire.fetch })} workspaceId={WS_ID} />
    </SessionRolesProvider>,
  );
  return wire.calls;
}

describe("workspace browser hold banner", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    ["owner", false, true],
    ["admin", false, true],
    ["member", true, true],
    ["member", false, false],
    ["guest", true, false],
    ["guest", false, false],
  ] as const)("shows the hold to %s and release=%s/%s", async (role, heldByMe, canRelease) => {
    const calls = view(role, heldByMe);
    expect(await screen.findByText(/controlling this workspace browser/)).toBeVisible();
    const release = screen.queryByRole("button", { name: "Hand back browser" });
    expect(Boolean(release)).toBe(canRelease);
    if (release) {
      fireEvent.click(release);
      await waitFor(() =>
        expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
          "POST /api/workspaces/ws_1/handback",
        ),
      );
    }
  });
});
