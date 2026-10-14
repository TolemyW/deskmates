// @vitest-environment jsdom
// T0: the operator UI's language (issue #23, decision 2). A stored preference wins, then the
// browser's languages, then English; the Language control under Account settings → Preferences
// switches at once, keeps `<html lang>` in step and stores the choice with
// `PATCH /auth/preferences`. Appearance sits beside it; the sidebar has no separate Settings.
import type { UserPreferences } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { installFakeEventSource } from "./test-support/fixtures.js";
import { selectOption } from "./test-support/select.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function stubGateway(preferences: UserPreferences | undefined, patchStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (path === "/auth/session")
        return json({
          authenticated: true,
          user: { id: "usr_1", displayName: "Pat", loginName: "pat" },
          tenant: { id: "tnt_default", name: "Default Tenant", role: "owner" },
          session: {
            authenticatedAt: "2026-10-05T00:00:00.000Z",
            idleExpiresAt: "2026-10-12T00:00:00.000Z",
            absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
          },
          csrfToken: "session-csrf-1",
          ...(preferences ? { preferences } : {}),
        });
      if (path === "/auth/preferences" && method === "PATCH") {
        if (patchStatus !== 200) return json({ code: "unavailable", message: "down" }, patchStatus);
        const change = JSON.parse(String(init?.body)) as UserPreferences;
        return json({ preferences: { ...preferences, ...change } });
      }
      if (path === "/api/config") return json({ release: null });
      if (path.startsWith("/api/workspaces")) return json({ workspaces: [] });
      if (path.startsWith("/api/bots")) return json({ bots: [] });
      if (path.startsWith("/api/threads")) return json({ threads: [] });
      if (path.startsWith("/api/approvals")) return json({ approvals: [] });
      return json({ code: "unavailable", message: "not stubbed" }, 503);
    }),
  );
  return calls;
}

function stubBrowserLanguages(languages: string[]): void {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

/** Preferences live on Account settings, which the signed-in identity opens in any language. */
async function openPreferences() {
  fireEvent.click(await screen.findByRole("link", { name: /Pat/ }));
  await waitFor(() => expect(window.location.hash).toBe("#/account"));
}

beforeEach(() => {
  installFakeEventSource();
  window.location.hash = "#/threads";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
  document.documentElement.lang = "en";
});

describe("locale resolution", () => {
  it("uses the browser language when the person has no stored preference", async () => {
    stubBrowserLanguages(["fr-FR", "ja-JP"]);
    stubGateway({ firstRunChecklistDismissed: true });
    render(<App />);
    await openPreferences();
    const control = await screen.findByLabelText("言語");
    expect(control.textContent).toContain("日本語");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("uses English when no browser language is one the UI has", async () => {
    stubBrowserLanguages(["fr-FR"]);
    stubGateway(undefined);
    render(<App />);
    await openPreferences();
    const control = await screen.findByLabelText("Language");
    expect(control.textContent).toContain("English");
    expect(document.documentElement.lang).toBe("en");
  });

  it("prefers the stored preference over the browser language", async () => {
    stubBrowserLanguages(["ja-JP"]);
    stubGateway({ firstRunChecklistDismissed: true, locale: "es" });
    render(<App />);
    await openPreferences();
    const control = await screen.findByLabelText("Idioma");
    expect(control.textContent).toContain("Español");
    expect(document.documentElement.lang).toBe("es");
  });
});

describe("Language control", () => {
  it("switches at once, updates the document language and stores the choice", async () => {
    stubBrowserLanguages(["en-US"]);
    const calls = stubGateway({ firstRunChecklistDismissed: true });
    render(<App />);
    await openPreferences();
    const control = await screen.findByLabelText("Language");
    await selectOption(control, "繁體中文");
    expect(await screen.findByLabelText("語言")).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-TW");
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "/auth/preferences")).toEqual([
        { method: "PATCH", path: "/auth/preferences", body: { locale: "zh-TW" } },
      ]),
    );
  });

  it("offers each language under its own name", async () => {
    stubBrowserLanguages(["en-US"]);
    stubGateway({ firstRunChecklistDismissed: true });
    render(<App />);
    await openPreferences();
    const control = await screen.findByLabelText("Language");
    fireEvent.click(control);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "English",
      "简体中文",
      "繁體中文",
      "日本語",
      "Español",
    ]);
  });

  it("goes back to the previous language when the Gateway does not store the choice", async () => {
    stubBrowserLanguages(["en-US"]);
    stubGateway({ firstRunChecklistDismissed: true }, 503);
    render(<App />);
    await openPreferences();
    const control = await screen.findByLabelText("Language");
    await selectOption(control, "日本語");
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(await screen.findByLabelText("Language")).toBeTruthy();
  });
});

describe("appearance preferences", () => {
  it("keeps preferences on Account settings, not behind a sidebar gear, and persists appearance", async () => {
    stubBrowserLanguages(["en-US"]);
    stubGateway({ firstRunChecklistDismissed: true });
    window.localStorage.removeItem("deskmates.theme");
    render(<App />);
    const identity = await screen.findByRole("link", {
      name: "Account settings and preferences for Pat",
    });
    expect(identity).toHaveProperty(
      "title",
      expect.stringContaining("Account settings and preferences"),
    );
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.queryByLabelText("Language")).toBeNull();
    await openPreferences();
    const section = await screen.findByRole("region", { name: "Preferences" });
    expect(section).toBeTruthy();
    await selectOption("Appearance", "Dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(window.localStorage.getItem("deskmates.theme")).toBe("dark");
    expect(screen.queryByRole("dialog")).toBeNull();
    await selectOption("Appearance", "Use system setting");
    expect(window.localStorage.getItem("deskmates.theme")).toBeNull();
  });
});
