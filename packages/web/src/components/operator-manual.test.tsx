// @vitest-environment jsdom
// T1 (in-process): the bundled operator manual (issue #28). Topics, This screen, internal links
// and anchors navigate inside the manual without touching the app's hash route; Markdown renders
// safely; search is local; About states the running release and the guide's build truthfully;
// the UI chrome follows the locale and says when a topic is shown in English.

import type { UiLocale } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n-provider.js";
import type { WebBuild } from "../lib/build-info.js";
import { guideFingerprint } from "../lib/guide-manifest.js";
import type { GuidePage } from "../lib/guide.js";
import { GuideMarkdown, OperatorManual } from "./operator-manual.js";

const DEV: WebBuild = { release: null, revision: null };

function renderManual({
  locale = "en",
  screenPage = "tasks",
  runningRelease = null,
  build = DEV,
  onClose = vi.fn(),
}: {
  locale?: UiLocale;
  screenPage?: GuidePage;
  runningRelease?: string | null;
  build?: WebBuild;
  onClose?: () => void;
} = {}) {
  render(
    <I18nProvider locale={locale}>
      <OperatorManual
        screenPage={screenPage}
        runningRelease={runningRelease}
        build={build}
        onClose={onClose}
      />
    </I18nProvider>,
  );
  const name = locale === "zh-CN" ? "帮助" : "Help";
  return { onClose, manual: screen.getByRole("region", { name }) };
}

/** The article that shows the selected topic. */
const article = () => screen.getByRole("article");

beforeEach(() => {
  window.location.hash = "#/tasks";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OperatorManual", () => {
  it("opens on the guide index, lists every topic and takes focus", () => {
    const { manual } = renderManual();
    expect(within(article()).getByRole("heading", { level: 1 }).textContent).toBe(
      "Deskmates operator guide",
    );
    const topics = within(manual).getByRole("navigation", { name: "Manual topics" });
    for (const title of ["Getting started", "Tasks", "Approvals", "Chat channels", "Costs"])
      expect(within(topics).getByRole("button", { name: title })).toBeTruthy();
    expect(document.activeElement).toBe(within(manual).getByRole("heading", { name: "Help" }));
  });

  it("offers This screen first and opens the page for the captured screen", () => {
    const { manual } = renderManual({ screenPage: "approvals" });
    const topics = within(manual).getByRole("navigation", { name: "Manual topics" });
    const thisScreen = within(topics).getByRole("button", { name: /^This screen/ });
    expect(within(topics).getAllByRole("button")[0]).toBe(thisScreen);
    expect(thisScreen.textContent).toContain("Approvals");
    fireEvent.click(thisScreen);
    expect(within(article()).getByRole("heading", { level: 1 }).textContent).toBe("Approvals");
  });

  it("follows a guide link to another topic without changing the app's route", () => {
    renderManual();
    const [link] = within(article()).getAllByRole("button", { name: "Getting started" });
    fireEvent.click(link as HTMLElement);
    expect(within(article()).getByRole("heading", { level: 1 }).textContent).toBe(
      "Getting started",
    );
    expect(window.location.hash).toBe("#/tasks");
  });

  it("links a repository document outside the guide to GitHub at the built release", () => {
    renderManual({ build: { release: "v0.4.0", revision: null } });
    const ledger = within(article()).getByRole("link", { name: "M4 status ledger" });
    expect(ledger.getAttribute("href")).toBe(
      "https://github.com/TolemyW/deskmates/blob/v0.4.0/docs/design/m4-status-2026-10-04.md",
    );
    expect(ledger.getAttribute("target")).toBe("_blank");
    expect(ledger.getAttribute("rel")).toContain("noopener");
  });

  it("searches titles and body text locally, with empty and no-result states", () => {
    const { manual } = renderManual();
    const search = within(manual).getByRole("searchbox", { name: "Search the manual" });
    fireEvent.change(search, { target: { value: "WhatsApp" } });
    const results = within(manual).getByRole("list", { name: "Search results" });
    const first = within(results).getAllByRole("button")[0] as HTMLElement;
    expect(first.textContent).toContain("Chat channels");
    fireEvent.click(first);
    expect(within(article()).getByRole("heading", { level: 1 }).textContent).toBe("Chat channels");

    fireEvent.change(search, { target: { value: "qqq-no-such-words" } });
    expect(within(manual).getByText("No topics match “qqq-no-such-words”.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "  " } });
    expect(within(manual).queryByRole("list", { name: "Search results" })).toBeNull();
    expect(within(manual).getByRole("navigation", { name: "Manual topics" })).toBeTruthy();
  });

  it("shows one pane at a time on a narrow screen: topics, then the page, then back", () => {
    const { manual } = renderManual();
    const body = manual.querySelector(".manual-body") as HTMLElement;
    expect(body.dataset.pane).toBe("topics");
    const topics = within(manual).getByRole("navigation", { name: "Manual topics" });
    fireEvent.click(within(topics).getByRole("button", { name: "Tasks" }));
    expect(body.dataset.pane).toBe("content");
    fireEvent.click(within(manual).getByRole("button", { name: "All topics" }));
    expect(body.dataset.pane).toBe("topics");
  });

  it("closes with Back to work and with Escape", () => {
    const { onClose, manual } = renderManual();
    fireEvent.click(within(manual).getByRole("button", { name: "Back to work" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(within(manual).getByRole("searchbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("states an English-only topic in another UI language, and translates its chrome", () => {
    const { manual } = renderManual({ locale: "zh-CN" });
    expect(within(manual).getByRole("note").textContent).toBe("此主题仅提供英文版本，尚未翻译。");
    expect(within(manual).getByRole("button", { name: "返回工作" })).toBeTruthy();
    cleanup();
    const english = renderManual({ locale: "en" });
    expect(within(english.manual).queryByRole("note")).toBeNull();
  });
});

describe("About", () => {
  function openAbout(options: Parameters<typeof renderManual>[0]) {
    const { manual } = renderManual(options);
    fireEvent.click(within(manual).getByRole("button", { name: "About" }));
    return article();
  }

  it("says a development build has no release to match", () => {
    const about = openAbout({ runningRelease: "v0.4.0" });
    expect(about.textContent).toContain("Development build");
    expect(about.textContent).toContain(guideFingerprint());
    expect(about.textContent).not.toContain("matches the running release");
  });

  it("confirms a match only when the build and the Gateway name the same release", () => {
    const build = { release: "v0.4.0", revision: "4a87a5d0123456789abcdef" };
    expect(openAbout({ runningRelease: "v0.4.0", build }).textContent).toContain(
      "This manual was built with the running release, v0.4.0.",
    );
    cleanup();
    expect(openAbout({ runningRelease: "v0.5.0", build }).textContent).toContain(
      "This manual was built for v0.4.0, but the server reports v0.5.0.",
    );
    cleanup();
    expect(openAbout({ runningRelease: null, build }).textContent).toContain(
      "The server did not report a release",
    );
  });

  it("names GitHub explicitly for source and issues, and ships notices locally", () => {
    const about = openAbout({ build: { release: "v0.4.0", revision: null } });
    const source = within(about).getByRole("link", { name: /Source code/ });
    expect(source.getAttribute("href")).toBe("https://github.com/TolemyW/deskmates/tree/v0.4.0");
    expect(source.textContent).toContain("GitHub");
    const issue = within(about).getByRole("link", { name: /Report an issue/ });
    expect(issue.getAttribute("href")).toBe("https://github.com/TolemyW/deskmates/issues/new");
    for (const link of [source, issue]) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    const notices = within(about).getByRole("list", { name: "Open-source notices" });
    const files = within(notices)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(files).toContain("/third-party/HeroUI-LICENSE.txt");
    for (const href of files) expect(href).toMatch(/^\/third-party\/[\w.-]+\.txt$/);
  });
});

describe("GuideMarkdown", () => {
  const hostile = [
    "# Page",
    "",
    "## Delivery",
    "",
    '<img src=x onerror="alert(1)"> <script>alert(2)</script> <iframe src="https://evil.example"></iframe>',
    "",
    "[run](javascript:alert(1)) [data](data:text/html,x) [up](../../../etc/passwd) [ok](tasks.md#what-this-cannot-do) [here](#delivery) [web](https://example.com/x)",
    "",
    "![local](../../packages/web/public/x.png) ![remote](https://evil.example/x.png)",
  ].join("\n");

  function renderHostile(onNavigate = vi.fn()) {
    const { container } = render(
      <GuideMarkdown source={hostile} page="README" sourceRef="main" onNavigate={onNavigate} />,
    );
    return { container, onNavigate };
  }

  it("renders no raw HTML, script, embed or image", () => {
    const { container } = renderHostile();
    for (const tag of ["script", "img", "iframe", "embed", "object"])
      expect(container.querySelector(tag), tag).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("links only http(s) out of the app and leaves blocked targets as text", () => {
    const { container } = renderHostile();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("https://example.com/x");
    // The bare URL inside the literal <iframe> text is autolinked like any http(s) text.
    for (const href of hrefs) expect(href).toMatch(/^https:\/\//);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    expect(container.textContent).toContain("run");
    expect(container.textContent).toContain("up");
  });

  it("navigates guide links and anchors inside the manual", () => {
    const { container, onNavigate } = renderHostile();
    expect(container.querySelector("h2")?.id).toBe("manual-delivery");
    fireEvent.click(screen.getByRole("button", { name: "ok" }));
    expect(onNavigate).toHaveBeenLastCalledWith("tasks", "what-this-cannot-do");
    fireEvent.click(screen.getByRole("button", { name: "here" }));
    expect(onNavigate).toHaveBeenLastCalledWith("README", "delivery");
  });
});
