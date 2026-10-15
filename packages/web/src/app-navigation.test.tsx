// @vitest-environment jsdom
// T1 (in-process): the main navigation keeps a name for every destination when its labels are
// hidden. Between 721 and 1100 px the sidebar is an icon-only rail: app.css hides each link's
// label span with `display: none`, which also removes it from the accessibility tree, so the
// link itself must carry the name (issue #13).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { approval, installFakeEventSource } from "./test-support/fixtures.js";

const DESTINATIONS = [
  "Chats",
  "Contacts",
  "Tasks",
  "Attention, 1 pending",
  "Board",
  "Files",
  "Knowledge",
  "Skills",
  "Computer",
  "Costs",
  "Integrations",
  "People",
  // A tenant Owner sees Network (ADR-0027 amendment 1 decision 12, owner-decided 2026-10-14).
  "Network",
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let iconRail: HTMLStyleElement | undefined;

beforeEach(() => {
  window.location.hash = "#/threads";
  installFakeEventSource();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/auth/session")
        return json({
          authenticated: true,
          user: { id: "usr_1", displayName: "Olive Owner", loginName: "olive" },
          tenant: { id: "tnt_default", name: "Default Tenant", role: "owner" },
          session: {
            authenticatedAt: "2026-10-05T00:00:00.000Z",
            idleExpiresAt: "2026-10-12T00:00:00.000Z",
            absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
          },
          csrfToken: "session-csrf-1",
        });
      if (path === "/api/config") return json({ release: null });
      if (path.startsWith("/api/workspaces")) return json({ workspaces: [] });
      if (path.startsWith("/api/bots")) return json({ bots: [] });
      if (path.startsWith("/api/threads")) return json({ threads: [] });
      if (path.startsWith("/api/approvals?status=pending"))
        return json({ approvals: [approval()] });
      if (path.startsWith("/api/members")) return json({ members: [] });
      if (path.startsWith("/api/invitations")) return json({ invitations: [] });
      return json({ approvals: [] });
    }),
  );
});

afterEach(() => {
  iconRail?.remove();
  iconRail = undefined;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The main navigation once all thirteen links and the pending-approval badge have rendered. */
async function renderNavigation(): Promise<HTMLElement> {
  render(<App />);
  const nav = await screen.findByRole("navigation", { name: "Main navigation" });
  await waitFor(() => expect(within(nav).getAllByRole("link")).toHaveLength(DESTINATIONS.length));
  await within(nav).findByText("1");
  return nav;
}

it("names every main destination with its labels shown", async () => {
  const nav = await renderNavigation();
  const links = within(nav).getAllByRole("link");
  for (const [index, name] of DESTINATIONS.entries())
    expect(within(nav).getByRole("link", { name })).toBe(links[index]);
});

it("names every main destination in the icon-only rail", async () => {
  // The rule app.css applies at max-width 1100px; jsdom does not evaluate media queries.
  iconRail = document.createElement("style");
  iconRail.textContent = ".sidebar nav a > span:not(.badge) { display: none; }";
  document.head.append(iconRail);
  const nav = await renderNavigation();
  const links = within(nav).getAllByRole("link");
  for (const [index, name] of DESTINATIONS.entries())
    expect(within(nav).getByRole("link", { name })).toBe(links[index]);
});

it("groups Files, Knowledge and Skills under Resources and puts Computer first under Operate (issue #27)", async () => {
  const nav = await renderNavigation();
  const groups = [...nav.querySelectorAll(".nav-group")].map((group) => ({
    label: group.querySelector(".nav-group-label")?.textContent,
    links: within(group as HTMLElement)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href")),
  }));
  expect(groups).toEqual([
    { label: "Talk", links: ["#/threads", "#/contacts", "#/tasks", "#/approvals", "#/board"] },
    { label: "Resources", links: ["#/resources/files", "#/knowledge/documents", "#/skills"] },
    {
      label: "Operate",
      links: ["#/computer", "#/costs", "#/integrations", "#/members", "#/network"],
    },
  ]);
});

it("scrolls the current link into view inside the navigation when the route changes", async () => {
  // Below about 768px of height the navigation scrolls inside its own region (layout verified in
  // on the 2026-10-10 sidebar fixes); the page that is open must not hide below it.
  const scrolled: Array<{ href: string | null; options: unknown }> = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
    scrolled.push({ href: this.getAttribute("href"), options });
  };
  try {
    window.location.hash = "#/members";
    await renderNavigation();
    await waitFor(() => expect(scrolled.at(-1)?.href).toBe("#/members"));
    expect(scrolled.at(-1)?.options).toEqual({ block: "nearest" });
    window.location.hash = "#/costs";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(scrolled.at(-1)?.href).toBe("#/costs"));
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

it("keeps one compact footer: status and Help on a row, the identity below, no Settings gear", async () => {
  const { container } = render(<App />);
  await screen.findByRole("navigation", { name: "Main navigation" });
  const footer = container.querySelector(".sidebar-footer") as HTMLElement;
  const status = footer.querySelector(".sidebar-status-row") as HTMLElement;
  expect(status).not.toBeNull();
  expect(within(status).getByText("Connected")).toBeTruthy();
  expect(within(status).getByRole("button", { name: "Help" })).toBeTruthy();
  expect(
    within(footer).getByRole("link", { name: /^Account settings and preferences for / }),
  ).toBeTruthy();
  expect(within(footer).queryByRole("button", { name: "Settings" })).toBeNull();
  expect(footer.querySelector(".preferences-trigger")).toBeNull();
});

it("redirects an old Facts link to Observations and marks Knowledge current", async () => {
  window.location.hash = "#/workspace/facts";
  const nav = await renderNavigation();
  expect(window.location.hash).toBe("#/knowledge/observations");
  expect(within(nav).getByRole("link", { name: "Knowledge" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(within(nav).getByRole("link", { name: "Skills" }).getAttribute("aria-current")).toBeNull();
});
