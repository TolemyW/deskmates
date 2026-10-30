// @vitest-environment jsdom
// T1 (in-process): the one Help entry opens the bundled manual inside the app (issue #28). Its
// "This screen" names the screen the shell actually showed, including role redirects; closing it
// returns focus to Help; the conversation, its unsent draft and the work area underneath stay
// mounted; the identity link still reaches Account settings, whose Preferences selects work once
// the manual has closed; and nothing is fetched from GitHub.
import type { TenantRole } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import {
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspace,
  workspaceView,
} from "./test-support/fixtures.js";
import { selectOption } from "./test-support/select.js";

function session(role: TenantRole) {
  return {
    authenticated: true,
    user: { id: "usr_1", displayName: "Pat", loginName: "pat" },
    tenant: { id: "tnt_default", name: "Default Tenant", role },
    session: {
      authenticatedAt: "2026-10-05T00:00:00.000Z",
      idleExpiresAt: "2026-10-12T00:00:00.000Z",
      absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
    },
    csrfToken: "session-csrf-1",
    preferences: { firstRunChecklistDismissed: true },
  };
}

/** A Gateway with one thread and its transcript; every request is recorded. */
function stubGateway(role: TenantRole) {
  const stub = fakeFetch({
    "GET /auth/session": session(role),
    "GET /api/config": { release: "v0.4.0" },
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/bots": { bots: [bot] },
    "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
    "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
    "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": {
      messages: [message(1, "human", "check the console"), message(2, "bot", "on it")],
    },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending": { approvals: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/members": { members: [] },
    "GET /api/invitations": { invitations: [] },
  });
  vi.stubGlobal("fetch", stub.fetch);
  return stub;
}

const help = () => screen.findByRole("button", { name: "Help" });
const manual = () => screen.queryByRole("region", { name: "Help" });
const thisScreen = (region: HTMLElement) =>
  within(within(region).getByRole("navigation", { name: "Manual topics" })).getByRole("button", {
    name: /^This screen/,
  });

beforeEach(() => {
  installFakeEventSource();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("Help", () => {
  for (const role of ["owner", "admin", "member"] as const) {
    it(`is one in-app entry for a ${role}, with no GitHub link in the sidebar`, async () => {
      window.location.hash = "#/tasks";
      stubGateway(role);
      const { container } = render(<App />);
      const button = await help();
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("link", { name: "Help" })).toBeNull();
      expect(screen.queryByRole("link", { name: "About this screen" })).toBeNull();
      expect(container.querySelector(".sidebar a[href*='github']")).toBeNull();
    });
  }

  it("opens the bundled manual with This screen for the screen being shown", async () => {
    window.location.hash = "#/tasks";
    const { calls } = stubGateway("member");
    render(<App />);
    fireEvent.click(await help());
    const region = manual();
    if (!region) throw new Error("manual did not open");
    expect((await help()).getAttribute("aria-expanded")).toBe("true");
    expect(thisScreen(region).textContent).toContain("Tasks");
    fireEvent.click(thisScreen(region));
    expect(within(region).getByRole("article").querySelector("h1")?.textContent).toBe("Tasks");
    // Opening a topic is not navigation: the work underneath keeps its route.
    expect(window.location.hash).toBe("#/tasks");
    expect(calls.some((call) => /github/i.test(call.path))).toBe(false);
  });

  it("names the screen a role redirect shows, not the route asked for", async () => {
    window.location.hash = "#/members";
    stubGateway("member");
    render(<App />);
    fireEvent.click(await help());
    expect(thisScreen(manual() as HTMLElement).textContent).toContain("Chats and groups");
    cleanup();

    window.location.hash = "#/members";
    stubGateway("owner");
    render(<App />);
    fireEvent.click(await help());
    expect(thisScreen(manual() as HTMLElement).textContent).toContain("People and roles");
  });

  it("returns focus to Help on Back to work and on Escape", async () => {
    window.location.hash = "#/tasks";
    stubGateway("owner");
    render(<App />);
    const button = await help();
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to work" }));
    expect(manual()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));

    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search the manual" }), {
      key: "Escape",
    });
    expect(manual()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("keeps the conversation and its unsent draft mounted under the manual", async () => {
    window.location.hash = "#/threads/thr_1";
    stubGateway("owner");
    const { container } = render(<App />);
    await screen.findByText("check the console");
    const work = container.querySelector("main.content") as HTMLElement;
    const transcript = screen.getByLabelText("Transcript");
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "unsent draft" } });

    fireEvent.click(await help());
    expect(manual()).not.toBeNull();
    // Underneath, not replaced: the same nodes, made inert so nothing there takes focus.
    expect(work.isConnected && work.hasAttribute("inert")).toBe(true);
    expect(transcript.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to work" }));

    expect(work.hasAttribute("inert")).toBe(false);
    expect(screen.getByLabelText("Transcript")).toBe(transcript);
    expect(screen.getByLabelText("Message")).toBe(box);
    expect(box.value).toBe("unsent draft");
    expect(window.location.hash).toBe("#/threads/thr_1");
  });

  it("closes when the operator navigates elsewhere", async () => {
    window.location.hash = "#/tasks";
    stubGateway("owner");
    render(<App />);
    fireEvent.click(await help());
    expect(manual()).not.toBeNull();
    window.location.hash = "#/costs";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(manual()).toBeNull());
  });

  it("lets the identity link leave the manual for Account settings and its Preferences", async () => {
    window.location.hash = "#/tasks";
    stubGateway("owner");
    render(<App />);
    fireEvent.click(await help());
    expect(manual()).not.toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Account settings for Pat" }));
    await waitFor(() => expect(manual()).toBeNull());
    await screen.findByRole("region", { name: "Profile" });
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    await screen.findByRole("dialog", { name: "Preferences" });
    await selectOption("Appearance", "Dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    await selectOption("Appearance", "Use system setting");
  });
});
