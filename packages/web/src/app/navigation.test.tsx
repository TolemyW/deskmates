// @vitest-environment jsdom
// T1 (in-process): the shell renders whatever navigation the features declare (issue #53).
// Nothing here lists the entries: expectations are computed from the feature registry, so a new
// feature adds its own `feature.test.tsx` and leaves this file alone. Checked for each role:
// the groups, each visible link's address, name, label, icon and current state at every address
// the routes parse, a drawer address keeping the screen behind it current, and the badge markup.
import { type TenantRole, mayTakeAction } from "@deskmates/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { ENGLISH } from "../i18n/catalogs.js";
import { I18nProvider } from "../i18n/i18n-provider.js";
import { parseRoute } from "../router.js";
import { installFakeEventSource } from "../test-support/fixtures.js";
import { NAV_GROUPS, type NavEntry } from "./feature.js";
import { featureFor, navigationGroups } from "./features.js";
import { NavLink } from "./navigation.js";
import { ROUTE_MODULES } from "./route-registry.js";
import type { Route } from "./routes.js";
import { STUB_CONTEXT } from "./testing/feature-expectations.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubGateway(role: TenantRole): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/auth/session")
        return json({
          authenticated: true,
          user: { id: "usr_1", displayName: "Olive Owner", loginName: "olive" },
          tenant: { id: "tnt_default", name: "Default Tenant", role },
          session: {
            authenticatedAt: "2026-10-05T00:00:00.000Z",
            idleExpiresAt: "2026-10-12T00:00:00.000Z",
            absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
          },
          csrfToken: "session-csrf-1",
          preferences: { firstRunChecklistDismissed: true },
        });
      if (path === "/api/config") return json({ release: null });
      if (path.startsWith("/api/workspaces")) return json({ workspaces: [] });
      if (path.startsWith("/api/bots")) return json({ bots: [] });
      if (path.startsWith("/api/threads")) return json({ threads: [] });
      if (path.startsWith("/api/approvals")) return json({ approvals: [] });
      if (path.startsWith("/api/members")) return json({ members: [] });
      if (path.startsWith("/api/invitations")) return json({ invitations: [] });
      // Screens behind other entries load what they need; an unknown path is not found.
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }),
  );
}

/** Every address the route modules parse: each segment bare and with a second segment. */
function addresses(): string[] {
  const hashes = [""];
  for (const module of ROUTE_MODULES.values())
    for (const segment of Object.keys(module.segments))
      hashes.push(`#/${segment}`, `#/${segment}/x`);
  return hashes.filter((hash) => parseRoute(hash).name !== "invite");
}

const GROUP_LABELS = { talk: "Talk", resources: "Resources", operate: "Operate" };

/**
 * The navigation as the registry says it should look for a role at a route, with the role facts
 * the shell checks (a root-only link is hidden from a non-root Owner).
 */
function expectedNavigation(route: Route, role: TenantRole) {
  const manager = role !== "member";
  const can = (action: Parameters<typeof mayTakeAction>[1]) =>
    mayTakeAction({ tenantRole: role, platformMaintainer: false }, action);
  return navigationGroups().map(({ group, entries }) => ({
    label: GROUP_LABELS[group],
    links: entries
      .filter(({ nav }) => nav.visible?.({ manager, can }) ?? true)
      .map(({ nav }) => {
        const active = nav.active(route);
        const label = ENGLISH[nav.label];
        return {
          href: nav.href(),
          className: active ? "active" : "",
          current: active ? "page" : null,
          name: label,
          title: label,
          icon: true,
          html: `<svg/><span>${label}</span>`,
        };
      }),
  }));
}

function renderedNavigation(nav: HTMLElement) {
  return [...nav.querySelectorAll(".nav-group")].map((group) => ({
    label: group.querySelector(".nav-group-label")?.textContent,
    links: [...group.querySelectorAll("a")].map((link) => ({
      href: link.getAttribute("href"),
      className: link.getAttribute("class"),
      current: link.getAttribute("aria-current"),
      name: link.getAttribute("aria-label"),
      title: link.getAttribute("title"),
      icon: link.querySelector("svg")?.getAttribute("class")?.startsWith("lucide ") === true,
      html: link.innerHTML.replace(/<svg[\s\S]*?<\/svg>/, "<svg/>"),
    })),
  }));
}

async function mainNavigation(): Promise<HTMLElement> {
  // Queried by selector: an open run drawer hides the navigation from the accessibility tree.
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>('nav[aria-label="Main navigation"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
}

beforeEach(() => {
  installFakeEventSource();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("main navigation from the feature registry", () => {
  it("has the three sidebar groups, in order", () => {
    expect(NAV_GROUPS).toEqual(["talk", "resources", "operate"]);
  });

  for (const role of ["owner", "admin", "member"] as const) {
    it(`shows a ${role} every entry it may use, current where the route says, at every address`, async () => {
      const manager = role !== "member";
      stubGateway(role);
      window.location.hash = "";
      render(<App />);
      const nav = await mainNavigation();
      // A drawer address keeps the screen behind it, so the current entry stays put.
      let background: Route = parseRoute("");
      for (const hash of addresses()) {
        act(() => {
          window.location.hash = hash;
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        });
        const route = parseRoute(hash);
        if (featureFor(route)?.drawer === undefined) background = route;
        await waitFor(() =>
          expect(renderedNavigation(nav), hash).toEqual(expectedNavigation(background, role)),
        );
      }
    }, 60_000);
  }

  it("a Guest sees only what they may read, and a hidden screen's address shows Chats (ADR-0022 amendment 7 S6)", async () => {
    stubGateway("guest");
    window.location.hash = "#/costs";
    render(<App />);
    const nav = await mainNavigation();
    const guest = { tenantRole: "guest", platformMaintainer: false } as const;
    const expected = navigationGroups().flatMap(({ entries }) =>
      entries
        .filter(
          ({ nav: entry }) =>
            entry.visible?.({
              manager: false,
              can: (action) => mayTakeAction(guest, action),
            }) ?? true,
        )
        .map(({ nav: entry }) => ENGLISH[entry.label]),
    );
    expect(expected).toEqual(["Chats", "Contacts", "Board"]);
    await waitFor(() =>
      expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("aria-label"))).toEqual(
        expected,
      ),
    );
    // The address names Costs, but the work area shows Chats and never asks for costs.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0]),
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((path) => path.startsWith("/api/costs"))).toBe(false);
    expect(calls.some((path) => path.startsWith("/api/approvals"))).toBe(false);
  });

  it("keeps the landing screen's entry current when a drawer address is opened directly", async () => {
    const drawer = addresses().find((hash) => featureFor(parseRoute(hash))?.drawer);
    expect(drawer).toBeDefined();
    stubGateway("owner");
    window.location.hash = drawer as string;
    render(<App />);
    const nav = await mainNavigation();
    await waitFor(() =>
      expect(renderedNavigation(nav)).toEqual(expectedNavigation({ name: "threads" }, "owner")),
    );
  });
});

describe("a navigation link", () => {
  const entry: NavEntry = {
    group: "talk",
    order: 1,
    icon: <i />,
    label: "app.nav.attention",
    href: () => "#/somewhere",
    active: () => false,
    badge: { useCount: () => 2, name: (t, count) => t("app.nav.attentionPending", { count }) },
  };

  it("names itself with its badge count and shows the badge to sighted users only", () => {
    const { container } = render(
      <I18nProvider locale="en">
        <NavLink entry={entry} active={true} ctx={STUB_CONTEXT} />
      </I18nProvider>,
    );
    const link = container.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/somewhere");
    expect(link.getAttribute("class")).toBe("active");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.getAttribute("aria-label")).toBe("Attention, 2 pending");
    expect(link.getAttribute("title")).toBe("Attention, 2 pending");
    expect(link.innerHTML).toBe(
      '<i></i><span>Attention</span><span class="badge" aria-hidden="true">2</span>',
    );
  });

  it("carries its label as its name, and no badge, at a count of zero", () => {
    const quiet = { ...entry, badge: { ...entry.badge, useCount: () => 0 } } as NavEntry;
    const { container } = render(
      <I18nProvider locale="en">
        <NavLink entry={quiet} active={false} ctx={STUB_CONTEXT} />
      </I18nProvider>,
    );
    const link = container.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("class")).toBe("");
    expect(link.getAttribute("aria-current")).toBeNull();
    expect(link.getAttribute("aria-label")).toBe("Attention");
    expect(link.innerHTML).toBe("<i></i><span>Attention</span>");
  });
});
