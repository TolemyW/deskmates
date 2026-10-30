// @vitest-environment jsdom
// The workspace detail's Working directories section (ADR-0036 as amended by ADR-0038): shows the
// effective mode with its source and the read-only note; saves through the API, clearing what is
// blank. There is no repository field: each bot clones its own code.

import "@testing-library/jest-dom/vitest";
import type { WorkdirSettingsView, WorkspaceDirectoryEntry } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { WorkdirSection } from "./workdir-section.js";

afterEach(cleanup);

const entry = { id: "ws_1", name: "Code" } as WorkspaceDirectoryEntry;

function view(extra: Partial<WorkdirSettingsView> = {}): WorkdirSettingsView {
  return {
    workspaceId: "ws_1",
    settings: {},
    effective: { mode: "per-bot", source: "gateway", laneNotice: false },
    gatewayMode: "per-bot",
    ...extra,
  };
}

function client(initial: WorkdirSettingsView) {
  const puts: unknown[] = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      const next = view({
        settings: { mode: "shared" },
        effective: { mode: "shared", source: "workspace", laneNotice: false },
      });
      return Response.json({ workdir: next });
    }
    return Response.json({ workdir: initial });
  });
  return { api: createApiClient({ fetch: fetcher }), puts };
}

it("shows the inherited per-bot mode and the read-only note, with no repository", async () => {
  const { api } = client(view());
  render(<WorkdirSection api={api} entry={entry} onChanged={() => {}} />);
  expect(
    await screen.findByText("Own directory per Bot (/work/bots/…) · server default"),
  ).toBeTruthy();
  expect(screen.getByText(/not a security boundary/)).toBeTruthy();
  expect(screen.queryByText(/git repository/)).toBeNull();
});

it("saves the shared mode and clears the lane notice", async () => {
  const { api, puts } = client(view());
  render(<WorkdirSection api={api} entry={entry} onChanged={() => {}} />);
  fireEvent.click(await screen.findByText("Edit working directories"));
  expect(screen.queryByLabelText("Shared git repository")).toBeNull();
  fireEvent.change(screen.getByLabelText("Start directory"), { target: { value: "shared" } });
  expect(screen.getByText(/clones its own copy/)).toBeTruthy();
  fireEvent.click(screen.getByText("Save working directories"));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({ mode: "shared", laneNotice: null });
  expect(await screen.findByText(/workspace setting/)).toBeTruthy();
});

it("retries a failed read without saving a directory mode", async () => {
  const { api, puts } = client(view());
  vi.spyOn(api, "getWorkspaceWorkdir").mockRejectedValueOnce(new Error("Read unavailable"));
  render(<WorkdirSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Read unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry loading settings" }));
  expect(await screen.findByText("Edit working directories")).toBeInTheDocument();
  expect(puts).toEqual([]);
});

it("locks the submitted draft while saving and keeps it on failure until Cancel", async () => {
  const { api } = client(view());
  let reject!: (error: Error) => void;
  vi.spyOn(api, "setWorkspaceWorkdir").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(<WorkdirSection api={api} entry={entry} onChanged={() => {}} />);
  fireEvent.click(await screen.findByText("Edit working directories"));
  const mode = screen.getByLabelText("Start directory");
  expect(mode).toHaveFocus();
  expect(screen.getByRole("button", { name: "Save working directories" })).toBeDisabled();
  fireEvent.change(mode, { target: { value: "shared" } });
  fireEvent.click(screen.getByText("Save working directories"));
  expect(mode).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => reject(new Error("Save refused")));
  expect(screen.getByRole("alert")).toHaveTextContent("Save refused");
  expect(mode).toHaveValue("shared");
  expect(mode).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Edit working directories" })).toHaveFocus();
  fireEvent.click(screen.getByText("Edit working directories"));
  expect(screen.getByLabelText("Start directory")).toHaveValue("inherit");
});
