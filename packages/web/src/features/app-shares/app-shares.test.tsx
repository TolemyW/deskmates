// @vitest-environment jsdom
// Published apps in the UI (ADR-0035): the workspace's Apps section lists state and address,
// opens in a new tab through the entry page and lets Admins stop sharing; the entry page posts the
// one-use ticket to the app origin in a form, never in an address.

import type { AppShare, WorkspaceDirectoryEntry, WorkspaceId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { AppOpenScreen } from "./app-open-screen.js";
import { AppSharesSection } from "./app-shares-section.js";

afterEach(cleanup);

const share = (extra: Partial<AppShare> = {}): AppShare => ({
  id: "app_1",
  workspaceId: "ws_1",
  port: 3000,
  label: "Todo app",
  url: "http://abc.apps.localhost:8790/",
  botId: "bot_1",
  runId: "run_1",
  createdAt: "2026-10-14T09:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  state: "available",
  ...extra,
});

const entry = (myRole: WorkspaceDirectoryEntry["myRole"]): WorkspaceDirectoryEntry => ({
  id: "ws_1" as WorkspaceId,
  name: "W",
  myRole,
  pinned: false,
  botCount: 1,
  activeRuns: null,
  lastActivityAt: "2026-10-14T09:00:00.000Z",
  createdAt: "2026-10-14T09:00:00.000Z",
  openInternet: true,
});

function client(shares: AppShare[]) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const body =
      init?.method === "DELETE"
        ? { share: share({ state: "revoked", revokedAt: "2026-10-14T10:00:00.000Z" }) }
        : path.endsWith("/open")
          ? {
              enterUrl: "http://abc.apps.localhost:8790/__deskmates/enter",
              ticket: "t".repeat(64),
              expiresIn: 30,
            }
          : { enabled: true, shares };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

it("lists each app with its state and address and opens it in a new tab", async () => {
  const { api } = client([
    share(),
    share({
      id: "app_2",
      label: "Stopped",
      state: "unavailable",
      url: "http://def.apps.localhost:8790/",
    }),
  ]);
  render(<AppSharesSection api={api} entry={entry("member")} onChanged={() => {}} />);
  expect(await screen.findByText("Todo app")).toBeTruthy();
  expect(screen.getByText("http://abc.apps.localhost:8790/")).toBeTruthy();
  expect(screen.getByText(/port 3000 · running/)).toBeTruthy();
  expect(screen.getByText(/Nothing answers on this port/)).toBeTruthy();
  const open = screen.getAllByText("Open")[0]?.closest("a");
  expect(open?.getAttribute("href")).toBe("#/apps/app_1?ws=ws_1");
  expect(open?.getAttribute("target")).toBe("_blank");
  expect(open?.getAttribute("rel")).toContain("noopener");
  // A Member cannot stop sharing.
  expect(screen.queryByText("Stop sharing")).toBeNull();
});

it("lets an Admin stop sharing after confirming", async () => {
  const { api, calls } = client([share()]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<AppSharesSection api={api} entry={entry("admin")} onChanged={() => {}} />);
  fireEvent.click(await screen.findByText("Stop sharing"));
  expect(await screen.findByText(/sharing stopped/)).toBeTruthy();
  expect(calls).toContain("DELETE /api/workspaces/ws_1/app-shares/app_1");
});

it("shows nothing to a Guest and asks nothing of the Gateway", async () => {
  const { api, calls } = client([share()]);
  const { container } = render(
    <AppSharesSection api={api} entry={entry("guest")} onChanged={() => {}} />,
  );
  expect(container.textContent).toBe("");
  expect(calls).toEqual([]);
});

it("posts the ticket to the app origin in a form, never in the address", async () => {
  const { api, calls } = client([]);
  const submitted: HTMLFormElement[] = [];
  render(
    <AppOpenScreen
      api={api}
      workspaceId="ws_1"
      shareId="app_1"
      path="/todos/7"
      submit={(form) => submitted.push(form)}
    />,
  );
  await waitFor(() => expect(submitted).toHaveLength(1));
  const form = submitted[0];
  expect(form?.method).toBe("post");
  expect(form?.action).toBe("http://abc.apps.localhost:8790/__deskmates/enter");
  expect(form?.action).not.toContain("t".repeat(64));
  expect((form?.elements.namedItem("ticket") as HTMLInputElement).value).toBe("t".repeat(64));
  expect(calls).toEqual(["POST /api/workspaces/ws_1/app-shares/app_1/open"]);
});
