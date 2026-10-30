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
import type { InterfaceView } from "../lib/interface-view.js";
import { parseRoute } from "../router.js";
import { FakeEventSource, installFakeEventSource } from "../test-support/fixtures.js";
import { NAV_GROUPS, type NavEntry, isCurrentEntry } from "./feature.js";
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

/**
 * `root`: the session is the protected root account. `analyticsUrl`: what `GET /api/config`
 * reports for the Analytics entry (ADR-0046 decision 8); absent by default, like a Gateway
 * without `OBSERVABILITY_GRAFANA_URL`.
 */
function stubGateway(
  role: TenantRole,
  { root = false, analyticsUrl }: { root?: boolean; analyticsUrl?: string } = {},
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/auth/session")
        return json({
          authenticated: true,
          ...(root ? { root: true } : {}),
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
      if (path === "/api/config")
        return json({ release: null, ...(analyticsUrl ? { analyticsUrl } : {}) });
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

const GROUP_LABELS = { talk: "Work", resources: "Resources", operate: "System" };

/** Choose the interface view the shell starts in, as the person's browser remembers it. */
function startIn(view: InterfaceView): void {
  if (view === "tune") window.localStorage.setItem("deskmates.view", "tune");
  else window.localStorage.removeItem("deskmates.view");
}

/**
 * The navigation as the registry says it should look for a role at a route, with the role facts
 * the shell checks (a root-only link is hidden from a non-root Owner) and the view (a link marked
 * for tuning shows only in the tune view). A group left with no link is not shown.
 */
function expectedNavigation(route: Route, role: TenantRole, view: InterfaceView = "use") {
  const manager = role !== "member";
  const can = (action: Parameters<typeof mayTakeAction>[1]) =>
    mayTakeAction({ tenantRole: role, platformMaintainer: false }, action);
  return navigationGroups()
    .map(({ group, entries }) => ({
      label: GROUP_LABELS[group],
      links: entries
        .filter(({ nav }) => nav.visible?.({ manager, can }) ?? true)
        .filter(({ nav }) => nav.audience !== "tune" || view === "tune")
        // An external entry is hidden while its address is unknown; this Gateway reports none.
        .filter(({ nav }) => nav.external === undefined)
        .map(({ nav }) => {
          const active = isCurrentEntry(nav, route);
          const label = ENGLISH[nav.label];
          return {
            href: nav.href?.(),
            className: active ? "active" : "",
            current: active ? "page" : null,
            name: label,
            title: label,
            icon: true,
            html: `<svg/><span>${label}</span>`,
          };
        }),
    }))
    .filter(({ links }) => links.length > 0);
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
  window.localStorage.removeItem("deskmates.view");
});

describe("main navigation from the feature registry", () => {
  it("has the three sidebar groups, in order", () => {
    expect(NAV_GROUPS).toEqual(["talk", "resources", "operate"]);
  });

  for (const [role, view] of [
    ["owner", "use"],
    ["owner", "tune"],
    ["admin", "use"],
    ["admin", "tune"],
    ["member", "use"],
    ["member", "tune"],
  ] as const) {
    it(`shows a ${role} in the ${view} view every entry it may use, current where the route says, at every address`, async () => {
      stubGateway(role);
      startIn(view);
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
          expect(renderedNavigation(nav), hash).toEqual(expectedNavigation(background, role, view)),
        );
      }
    }, 60_000);
  }

  it("shows a Guest an explicit permission page without loading a forbidden feature", async () => {
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
    expect(expected).toEqual(["Chats", "Bots", "Board"]);
    await waitFor(() =>
      expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("aria-label"))).toEqual(
        expected,
      ),
    );
    expect(document.querySelector('[data-testid="page-forbidden"]')?.textContent).toContain(
      "requires any member",
    );
    // The address names Costs, but the forbidden feature never asks for its data.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0]),
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((path) => path.startsWith("/api/costs"))).toBe(false);
    expect(calls.some((path) => path.startsWith("/api/approvals"))).toBe(false);
  });

  it("shows an explicit not-found page for an unknown address", async () => {
    stubGateway("owner");
    window.location.hash = "#/this-page-does-not-exist";
    render(<App />);
    await mainNavigation();
    await waitFor(() =>
      expect(document.querySelector('[data-testid="page-not-found"]')?.textContent).toContain(
        "Page not found",
      ),
    );
  });

  it("reports the real Gateway stream state and keeps an outage banner visible", async () => {
    stubGateway("owner");
    render(<App />);
    await mainNavigation();
    const status = document.querySelector(".workspace-health");
    expect(status?.textContent).toContain("Connecting");
    const stream = await waitFor(() => {
      const found = FakeEventSource.instances.find((candidate) =>
        candidate.url.startsWith("/api/events"),
      );
      expect(found).toBeDefined();
      return found as FakeEventSource;
    });
    act(() => stream.open());
    await waitFor(() => expect(status?.textContent).toContain("Connected"));
    act(() => stream.drop());
    await waitFor(() => {
      expect(status?.textContent).toContain("Offline");
      expect(document.querySelector(".gateway-offline-banner")?.textContent).toContain(
        "cannot reach the server",
      );
    });
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

describe("an external entry: Analytics (ADR-0046 decision 8)", () => {
  // The Gateway's same-origin relay to Grafana (ADR-0046 amendment 1 decision 16).
  const GRAFANA = "/analytics/";
  const external = navigationGroups()
    .flatMap(({ entries }) => entries)
    .filter(({ nav }) => nav.external !== undefined);
  const names = external.map(({ nav }) => `${ENGLISH[nav.label]} (opens in a new tab)`);

  const links = (nav: HTMLElement) =>
    [...nav.querySelectorAll("a")].filter((a) =>
      names.includes(a.getAttribute("aria-label") ?? ""),
    );

  const configAsked = () =>
    waitFor(() =>
      expect(
        (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
          (call) => String(call[0]) === "/api/config",
        ),
      ).toBe(true),
    );

  it("is the Analytics entry, for the root only", () => {
    expect(external.map(({ folder }) => folder)).toEqual(["analytics"]);
    const root = { tenantRole: "owner", platformMaintainer: false, root: true } as const;
    const owner = { tenantRole: "owner", platformMaintainer: false } as const;
    for (const { nav } of external) {
      expect(nav.visible?.({ manager: true, can: (a) => mayTakeAction(root, a) })).toBe(true);
      expect(nav.visible?.({ manager: true, can: (a) => mayTakeAction(owner, a) })).toBe(false);
    }
  });

  it("opens the relayed Grafana in a new tab for the root, and is never current", async () => {
    stubGateway("owner", { root: true, analyticsUrl: GRAFANA });
    startIn("tune");
    window.location.hash = "#/costs";
    render(<App />);
    const nav = await mainNavigation();
    await waitFor(() => expect(links(nav)).toHaveLength(external.length));
    for (const link of links(nav)) {
      expect(link.getAttribute("href")).toBe(GRAFANA);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("aria-current")).toBeNull();
      expect(link.getAttribute("title")).toBe(link.getAttribute("aria-label"));
      expect(link.innerHTML.replace(/<svg[\s\S]*?<\/svg>/, "<svg/>")).toBe(
        "<svg/><span>Analytics</span>",
      );
    }
  });

  it("is hidden from the root in the use view, the URL set", async () => {
    stubGateway("owner", { root: true, analyticsUrl: GRAFANA });
    render(<App />);
    const nav = await mainNavigation();
    await configAsked();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(links(nav)).toEqual([]);
  });

  it("is hidden from the root while the Gateway reports no analyticsUrl", async () => {
    stubGateway("owner", { root: true });
    startIn("tune");
    render(<App />);
    const nav = await mainNavigation();
    await configAsked();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(links(nav)).toEqual([]);
  });

  it("is hidden from an Owner who is not the root, with the URL set", async () => {
    stubGateway("owner", { analyticsUrl: GRAFANA });
    startIn("tune");
    render(<App />);
    const nav = await mainNavigation();
    await configAsked();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(links(nav)).toEqual([]);
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
    expect(link.getAttribute("aria-label")).toBe("Approvals, 2 pending");
    expect(link.getAttribute("title")).toBe("Approvals, 2 pending");
    expect(link.innerHTML).toBe(
      '<i></i><span>Approvals</span><span class="badge" aria-hidden="true">2</span>',
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
    expect(link.getAttribute("aria-label")).toBe("Approvals");
    expect(link.innerHTML).toBe("<i></i><span>Approvals</span>");
  });

  it("caps a large visible badge at 99+ while keeping the exact accessible count", () => {
    const busy = { ...entry, badge: { ...entry.badge, useCount: () => 124 } } as NavEntry;
    const { container } = render(
      <I18nProvider locale="en">
        <NavLink entry={busy} active={false} ctx={STUB_CONTEXT} />
      </I18nProvider>,
    );
    const link = container.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("aria-label")).toBe("Approvals, 124 pending");
    expect(link.querySelector(".badge")?.textContent).toBe("99+");
  });
});
