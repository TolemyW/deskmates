// @vitest-environment node
// T0: the bundled manual (issue #28) carries exactly the pages and assets of docs/guide/, byte for
// byte. A page added to docs/guide/ without a manifest line, or a manifest line without a page,
// fails here rather than shipping a manual that silently lacks it.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GUIDE_ASSETS,
  GUIDE_ENTRIES,
  guideEntry,
  guideFingerprint,
  isGuidePageId,
} from "./guide-manifest.js";
import { GUIDE_INDEX, SCREEN_GUIDE_PAGES } from "./guide.js";

const GUIDE_DIR = fileURLToPath(new URL("../../../../docs/guide/", import.meta.url));
const files = readdirSync(GUIDE_DIR);

describe("guide manifest", () => {
  it("bundles every Markdown page of docs/guide/ and nothing else", () => {
    const pages = files.filter((name) => name.endsWith(".md")).sort();
    expect(GUIDE_ENTRIES.map((entry) => `${entry.id}.md`).sort()).toEqual(pages);
  });

  it("bundles each page's text unchanged", () => {
    for (const entry of GUIDE_ENTRIES)
      expect(entry.source, entry.id).toBe(readFileSync(`${GUIDE_DIR}${entry.id}.md`, "utf8"));
  });

  it("lists every non-Markdown file of docs/guide/ as an asset, and no other", () => {
    const assets = files.filter((name) => !name.endsWith(".md")).sort();
    expect(Object.keys(GUIDE_ASSETS).sort()).toEqual(assets);
  });

  it("opens on the index and titles every page from its first heading", () => {
    expect(GUIDE_ENTRIES[0]?.id).toBe(GUIDE_INDEX);
    expect(guideEntry(GUIDE_INDEX).title).toBe("Deskmates operator guide");
    expect(guideEntry("tasks").title).toBe("Tasks");
    for (const entry of GUIDE_ENTRIES) expect(entry.title, entry.id).not.toMatch(/^#|^\s*$/);
  });

  it("has every screen's page", () => {
    for (const page of Object.values(SCREEN_GUIDE_PAGES)) expect(isGuidePageId(page)).toBe(true);
    expect(isGuidePageId("../design/m4-status-2026-10-04")).toBe(false);
    expect(isGuidePageId("constructor")).toBe(false);
  });

  it("is identified by a fingerprint of its content", () => {
    expect(guideFingerprint()).toMatch(/^[0-9a-f]{8}$/);
    expect(guideFingerprint()).toBe(guideFingerprint(GUIDE_ENTRIES));
    const changed = GUIDE_ENTRIES.map((entry, i) =>
      i === 1 ? { ...entry, source: `${entry.source} ` } : entry,
    );
    expect(guideFingerprint(changed)).not.toBe(guideFingerprint());
  });
});
