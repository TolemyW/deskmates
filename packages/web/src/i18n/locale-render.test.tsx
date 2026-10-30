import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  approval,
  bot,
  installFakeEventSource,
  task,
  workspace,
  workspaceView,
} from "../test-support/fixtures.js";
// @vitest-environment jsdom
// T0: the Chats, Tasks, Approvals, Management and People screens render in Simplified Chinese
// with no English left (issue #23, decision 4). Every catalog key the screens look up must have a
// zh-CN text of its own, and no text, label, title or placeholder on screen may be an English
// catalog text that zh-CN translates.
import { CATALOGS, type MessageKey } from "./catalogs.js";
import { observeLookups } from "./intl.js";
import allowlist from "./literal-allowlist.json";

const english: Record<string, string> = CATALOGS.en;
const chinese: Record<string, string> = CATALOGS["zh-CN"];

/**
 * Whether an English text has words a translation must change: what is left once arguments,
 * tags, allowlisted proper nouns and identifiers in code font are taken out.
 */
function needsTranslation(text: string): boolean {
  let rest = text
    .replace(/<code>[^<]*<\/code>/g, " ")
    .replace(/<\/?\w+>/g, " ")
    .replace(/\{\w+\}/g, " ")
    .replace(/\{\w+, *\w+(, *[^,{}]+)?(,|\})/g, " ")
    .replace(/[\w=]+ *\{/g, " ")
    .replace(/[{}#]/g, " ");
  for (const term of allowlist.terms) rest = rest.split(term).join(" ");
  return /\p{L}{2,}/u.test(rest);
}

/** The shared fixture workspace is called "default", which is also an English catalog text. */
const ops = { ...workspace, name: "galaxy-ops" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let inFlight = 0;

function stubGateway(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      inFlight += 1;
      try {
        const path = String(input).split("?")[0] ?? "";
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
            preferences: { firstRunChecklistDismissed: true, locale: "zh-CN" },
          });
        if (path === "/api/config") return json({ release: null });
        if (path === "/api/workspaces") return json({ workspaces: [ops] });
        if (path === `/api/workspaces/${workspace.id}`)
          return json(workspaceView({ workspace: ops }));
        if (path === `/api/workspaces/${workspace.id}/tasks`) return json({ tasks: [task()] });
        if (path === "/api/bots") return json({ bots: [bot] });
        if (path === "/api/threads") return json({ threads: [] });
        if (path === "/api/approvals") return json({ approvals: [approval()] });
        if (path === "/api/members") return json({ members: [] });
        if (path === "/api/invitations") return json({ invitations: [] });
        return json({ code: "unavailable", message: "not stubbed" }, 503);
      } finally {
        inFlight -= 1;
      }
    }),
  );
}

/** Every piece of text a person reads or hears on the page. */
function shownTexts(): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (text) texts.push(text);
  }
  for (const element of document.body.querySelectorAll("[aria-label],[title],[placeholder]"))
    for (const name of ["aria-label", "title", "placeholder"]) {
      const value = element.getAttribute(name)?.trim();
      if (value) texts.push(value);
    }
  return texts;
}

/** English catalog texts that zh-CN translates, for spotting one left on screen. */
const translatedEnglish = new Set(
  Object.keys(english)
    .filter((key) => needsTranslation(english[key] ?? "") && chinese[key] !== english[key])
    .map((key) => (english[key] ?? "").trim()),
);

beforeEach(() => {
  installFakeEventSource();
  stubGateway();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
  document.documentElement.lang = "en";
});

describe("the operator UI in zh-CN", () => {
  const screens: Array<[string, string]> = [
    ["Chats", "#/threads"],
    ["Tasks", "#/tasks"],
    ["Approvals", "#/approvals"],
    ["Computer", "#/computer"],
    ["Knowledge observations", "#/knowledge/observations"],
    ["Skills", "#/skills"],
    ["People", "#/members"],
  ];
  for (const [name, hash] of screens) {
    it(`renders ${name} with no English text`, async () => {
      const used = new Set<MessageKey>();
      const stop = observeLookups((locale, key) => {
        if (locale === "zh-CN") used.add(key);
      });
      try {
        window.location.hash = hash;
        render(<App />);
        // The signed-in identity, which opens Account settings.
        await screen.findByRole("link", { name: /的账号设置$/ });
        await waitFor(() => expect(inFlight).toBe(0));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await waitFor(() => expect(inFlight).toBe(0));
      } finally {
        stop();
      }
      expect(document.documentElement.lang).toBe("zh-CN");
      expect(used.size).toBeGreaterThan(10);
      const untranslated = [...used].filter(
        (key) => needsTranslation(english[key] ?? "") && chinese[key] === english[key],
      );
      expect(untranslated, "keys whose zh-CN text is the English text").toEqual([]);
      const leaked = shownTexts().filter((text) => translatedEnglish.has(text));
      expect(leaked, "English catalog texts on screen").toEqual([]);
    });
  }
});
