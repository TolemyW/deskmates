// @vitest-environment node
// T0: every screen names a guide page that exists in docs/guide/ (issue #22), and the manual's
// "This screen" names the screen actually shown, not the route asked for (issue #28). A renamed
// or deleted guide page fails here, not in a browser.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRoute } from "../router.js";
import { GUIDE_INDEX, SCREEN_GUIDE_PAGES, screenGuidePage, viewedScreen } from "./guide.js";

const GUIDE_DIR = fileURLToPath(new URL("../../../../docs/guide/", import.meta.url));
const pages = new Set(readdirSync(GUIDE_DIR).filter((name) => name.endsWith(".md")));

describe("guide pages", () => {
  it("names an existing guide page for every screen", () => {
    for (const [screen, page] of Object.entries(SCREEN_GUIDE_PAGES))
      expect(pages, `${screen} -> ${page}`).toContain(`${page}.md`);
  });

  it("has an index page the manual opens on", () => {
    expect(pages).toContain(`${GUIDE_INDEX}.md`);
  });

  it("links every topic page from the screens or the index", () => {
    const linked = new Set<string>(Object.values(SCREEN_GUIDE_PAGES));
    const unlinked = [...pages]
      .map((name) => name.replace(/\.md$/, ""))
      .filter((page) => page !== GUIDE_INDEX && !linked.has(page));
    // Pages no screen maps to are still reachable from the index and the topic list.
    expect(unlinked.sort()).toEqual(["using-deskmates-from-another-agent"]);
  });
});

describe("the screen being viewed", () => {
  const manager = { manager: true };
  const member = { manager: false };

  it("is the routed screen when the shell renders it", () => {
    expect(viewedScreen(parseRoute("#/tasks/tsk_1"), member)).toBe("tasks");
    expect(viewedScreen(parseRoute("#/costs"), member)).toBe("costs");
    expect(viewedScreen(parseRoute("#/members"), manager)).toBe("members");
    expect(viewedScreen(parseRoute("#/knowledge"), member)).toBe("knowledge");
  });

  it("follows the shell's role redirect: People is Chats for a Member", () => {
    expect(viewedScreen(parseRoute("#/members"), member)).toBe("threads");
    expect(screenGuidePage(parseRoute("#/members"), member)).toBe("chats-and-groups");
    expect(screenGuidePage(parseRoute("#/members"), manager)).toBe("people-and-roles");
  });

  it("maps the landing screen, and an unknown path that lands there, to getting started", () => {
    expect(viewedScreen(parseRoute(""), member)).toBe("home");
    expect(screenGuidePage(parseRoute("#/nowhere"), member)).toBe("getting-started");
  });

  it("maps legacy paths to the screen that renders them", () => {
    // `#/desktops` renders the contacts list, so its help is the bots page.
    expect(viewedScreen(parseRoute("#/desktops"), member)).toBe("contacts");
    expect(screenGuidePage(parseRoute("#/desktops"), member)).toBe("bots");
    expect(viewedScreen(parseRoute("#/channels/bot_1"), member)).toBe("channels");
    expect(screenGuidePage(parseRoute("#/channels/bot_1"), member)).toBe("channels");
  });
});
