// @vitest-environment jsdom
// Published apps in the UI (ADR-0035): the workspace's Apps section lists state and address,
// opens in a new tab through the entry page and lets Admins stop sharing; the entry page posts the
// one-use ticket to the app origin in a form, never in an address.

import type { AppShare, WorkspaceDirectoryEntry, WorkspaceId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { AppOpenScreen } from "./app-open-screen.js";
import { AppSharesPanel } from "./app-shares-panel.js";
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
  publishedBy: null,
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
        : init?.method === "POST" && path.endsWith("/app-shares")
          ? {
              share: share({
                id: "app_9",
                label: "Preview",
                port: 5173,
                botId: null,
                runId: null,
                publishedBy: "user:usr_mel",
                state: "unavailable",
                reason: "not_running",
              }),
              existing: false,
            }
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
});

it("lets a Member stop sharing after confirming (owner-decided 2026-10-14)", async () => {
  const { api, calls } = client([share()]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<AppSharesSection api={api} entry={entry("member")} onChanged={() => {}} />);
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

it("lets a Member share a running port and lists it first", async () => {
  const { api, calls } = client([share()]);
  render(<AppSharesSection api={api} entry={entry("member")} onChanged={() => {}} />);
  await screen.findByText("Todo app");
  const submit = screen.getByRole("button", { name: "Share" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "5173" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Preview " } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  expect(await screen.findByText("Preview")).toBeTruthy();
  expect(screen.getByText(/shared by a person/)).toBeTruthy();
  expect(calls).toContain("POST /api/workspaces/ws_1/app-shares");
  const items = screen
    .getAllByRole("listitem")
    .map((li) => li.querySelector("strong")?.textContent);
  expect(items).toEqual(["Preview", "Todo app"]);
});

it("submits the one-use ticket once, however often the shell re-renders (#63 M13)", async () => {
  const { api, calls } = client([]);
  const submitted: HTMLFormElement[] = [];
  const view = () => (
    <AppOpenScreen
      api={api}
      workspaceId="ws_1"
      shareId="app_1"
      // A new function on every render, as a parent re-render produces.
      submit={(form) => {
        submitted.push(form);
      }}
    />
  );
  const { rerender } = render(view());
  await waitFor(() => expect(submitted).toHaveLength(1));
  rerender(view());
  rerender(view());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(submitted).toHaveLength(1);
  expect(calls).toEqual(["POST /api/workspaces/ws_1/app-shares/app_1/open"]);
});

it("keeps a published app when a slower Refresh answers after it (#63 M13)", async () => {
  let release: (() => void) | undefined;
  const { api } = client([share()]);
  const listAppShares = api.listAppShares.bind(api);
  let slow = false;
  api.listAppShares = (workspaceId) => {
    const answer = listAppShares(workspaceId);
    if (!slow) return answer;
    return new Promise((resolve) => {
      release = () => resolve(answer);
    });
  };
  render(<AppSharesSection api={api} entry={entry("member")} onChanged={() => {}} />);
  await screen.findByText("Todo app");
  slow = true;
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "5173" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Preview" } });
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  expect(await screen.findByText("Preview")).toBeTruthy();
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByText("Preview")).toBeTruthy();
});

it("recovers an initial list failure without publishing an app", async () => {
  const { api, calls } = client([share()]);
  vi.spyOn(api, "listAppShares").mockRejectedValueOnce(new Error("Apps unavailable"));
  render(<AppSharesSection api={api} entry={entry("member")} onChanged={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Apps unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Todo app")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});

it("explains invalid and reserved ports before submitting", async () => {
  const { api, calls } = client([]);
  render(<AppSharesSection api={api} entry={entry("member")} onChanged={() => {}} />);
  const port = await screen.findByLabelText("Port");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Preview" } });
  for (const invalid of ["1000", "99999", "6080", "6086"]) {
    fireEvent.change(port, { target: { value: invalid } });
    expect(port.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/reserved for the workspace desktop/)).toBeTruthy();
  }
  fireEvent.change(port, { target: { value: "5173" } });
  expect(port.getAttribute("aria-invalid")).toBeNull();
  expect((screen.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(false);
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});

it("keeps an old publish response out of a newly selected workspace", async () => {
  const { api } = client([share()]);
  let finish!: (value: Awaited<ReturnType<typeof api.publishAppShare>>) => void;
  vi.spyOn(api, "publishAppShare").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onList = vi.fn();
  const { rerender } = render(<AppSharesPanel api={api} workspaceId="ws_1" onList={onList} />);
  await screen.findByText("Todo app");
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "5173" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Old draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  expect((screen.getByRole("button", { name: "Stop sharing" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  vi.spyOn(api, "listAppShares").mockResolvedValue({ enabled: true, shares: [] });
  rerender(<AppSharesPanel api={api} workspaceId="ws_2" onList={onList} />);
  await screen.findByText(/No apps published yet/);
  onList.mockClear();
  await act(async () => finish({ share: share({ label: "Late app" }), existing: false }));
  expect(screen.queryByText("Late app")).toBeNull();
  expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("");
  expect(onList).not.toHaveBeenCalled();
});

it("retries a failed app entry and submits only the successful ticket once", async () => {
  const { api } = client([]);
  const open = vi
    .spyOn(api, "openAppShare")
    .mockRejectedValueOnce(new Error("App temporarily unavailable"));
  const submit = vi.fn();
  render(<AppOpenScreen api={api} workspaceId="ws_1" shareId="app_1" submit={submit} />);
  await screen.findByRole("alert");
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(open).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
