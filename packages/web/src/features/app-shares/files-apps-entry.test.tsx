// @vitest-environment jsdom
// T0: the Files page's Apps entry (ADR-0035, owner-decided 2026-10-14) asks the Gateway nothing
// until opened, then shows the workspace's apps with Open, Stop sharing and the share form.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppSharesApi } from "./api.js";
import { FilesAppsEntry } from "./files-apps-entry.js";

afterEach(cleanup);

it("opens the apps panel on demand", async () => {
  const api: AppSharesApi = {
    listAppShares: vi.fn(async () => ({
      enabled: true,
      shares: [
        {
          id: "app_1",
          workspaceId: "ws_1",
          port: 3000,
          label: "Todo app",
          url: "https://abc.10.88.40.132.nip.io:18443/",
          botId: "bot_1",
          runId: "run_1",
          publishedBy: null,
          createdAt: "2026-10-14T09:00:00.000Z",
          revokedAt: null,
          revokedBy: null,
          state: "available" as const,
        },
      ],
    })),
    openAppShare: vi.fn(),
    publishAppShare: vi.fn(),
    revokeAppShare: vi.fn(),
  };
  render(<FilesAppsEntry api={api} workspaceId="ws_1" />);
  const toggle = screen.getByRole("button", { name: "Shared apps" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(api.listAppShares).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(await screen.findByText("Todo app")).toBeTruthy();
  expect(screen.getByText("https://abc.10.88.40.132.nip.io:18443/")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  expect(api.listAppShares).toHaveBeenCalledWith("ws_1");
});
