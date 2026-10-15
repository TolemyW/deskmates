// @vitest-environment jsdom
// The workspace detail's Working directories section (ADR-0036): shows the effective settings
// with their source and the convention note; saves through the API, clearing what is blank.

import type { WorkdirSettingsView, WorkspaceDirectoryEntry } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { WorkdirSection } from "./workdir-section.js";

afterEach(cleanup);

const entry = { id: "ws_1", name: "Code" } as WorkspaceDirectoryEntry;

function view(extra: Partial<WorkdirSettingsView> = {}): WorkdirSettingsView {
  return {
    workspaceId: "ws_1",
    settings: {},
    effective: { mode: "shared", source: "gateway", worktreeRepo: null, laneNotice: false },
    gatewayMode: "shared",
    ...extra,
  };
}

function client(initial: WorkdirSettingsView) {
  const puts: unknown[] = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      const next = view({
        settings: { mode: "per-bot", worktreeRepo: "/work/app" },
        effective: {
          mode: "per-bot",
          source: "workspace",
          worktreeRepo: "/work/app",
          laneNotice: false,
        },
      });
      return Response.json({ workdir: next });
    }
    return Response.json({ workdir: initial });
  });
  return { api: createApiClient({ fetch: fetcher }), puts };
}

it("shows the inherited mode, no repository and the convention note", async () => {
  const { api } = client(view());
  render(<WorkdirSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText("Shared /work · server default")).toBeTruthy();
  expect(screen.getByText("None")).toBeTruthy();
  expect(screen.getByText(/A convention, not a permission/)).toBeTruthy();
});

it("saves a per-bot mode with a repository and clears the lane notice", async () => {
  const { api, puts } = client(view());
  render(<WorkdirSection api={api} entry={entry} onChanged={() => {}} />);
  fireEvent.click(await screen.findByText("Edit working directories"));
  const repo = screen.getByLabelText("Shared git repository") as HTMLInputElement;
  expect(repo.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Start directory"), { target: { value: "per-bot" } });
  fireEvent.change(repo, { target: { value: "/work/app" } });
  expect(screen.getByText(/it is an experiment/)).toBeTruthy();
  fireEvent.click(screen.getByText("Save working directories"));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({ mode: "per-bot", worktreeRepo: "/work/app", laneNotice: null });
  expect(await screen.findByText("/work/app")).toBeTruthy();
  expect(screen.getByText(/workspace setting/)).toBeTruthy();
});

it("refuses a repository under /work/bots without calling the API", async () => {
  const { api, puts } = client(view());
  render(<WorkdirSection api={api} entry={entry} onChanged={() => {}} />);
  fireEvent.click(await screen.findByText("Edit working directories"));
  fireEvent.change(screen.getByLabelText("Start directory"), { target: { value: "per-bot" } });
  fireEvent.change(screen.getByLabelText("Shared git repository"), {
    target: { value: "/work/bots/nova" },
  });
  fireEvent.click(screen.getByText("Save working directories"));
  expect((await screen.findByRole("alert")).textContent).toContain("not under /work/bots");
  expect(puts).toHaveLength(0);
});
