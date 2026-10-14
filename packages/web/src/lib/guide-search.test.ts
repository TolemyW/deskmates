// @vitest-environment node
// T0: the manual searches only its bundled pages, titles and body text, locally (issue #28).

import { describe, expect, it } from "vitest";
import type { GuideEntry } from "./guide-manifest.js";
import { GUIDE_ENTRIES } from "./guide-manifest.js";
import { guidePlainText, searchGuide } from "./guide-search.js";

const entries: GuideEntry[] = [
  {
    id: "README",
    title: "Operator guide",
    source: "# Operator guide\n\nSee [Tasks](tasks.md) for tracking work.",
  },
  {
    id: "tasks",
    title: "Tasks",
    source: "# Tasks\n\nA task has an **owner** and a state.\n\n## Delivery\n\nApprovals gate it.",
  },
  {
    id: "approvals",
    title: "Approvals",
    source: "# Approvals\n\nAllow once, Always or Deny. A task may wait for one.",
  },
];

describe("searchGuide", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(searchGuide("", entries)).toEqual([]);
    expect(searchGuide("   ", entries)).toEqual([]);
  });

  it("ranks a title match before body matches", () => {
    const ids = searchGuide("approvals", entries).map((hit) => hit.entry.id);
    expect(ids).toEqual(["approvals", "tasks"]);
  });

  it("matches body text case-insensitively, with a snippet around the match", () => {
    const [hit, ...rest] = searchGuide("OWNER", entries);
    expect(rest).toEqual([]);
    expect(hit?.entry.id).toBe("tasks");
    expect(hit?.snippet).toContain("owner");
    expect(hit?.snippet).not.toContain("**");
  });

  it("requires every word of the query", () => {
    expect(searchGuide("task deny", entries).map((hit) => hit.entry.id)).toEqual(["approvals"]);
    expect(searchGuide("task nothing-here", entries)).toEqual([]);
  });

  it("does not match Markdown syntax or link targets", () => {
    expect(searchGuide("tasks.md", entries)).toEqual([]);
    expect(searchGuide("](", entries)).toEqual([]);
  });

  it("searches the bundled guide", () => {
    const ids = searchGuide("WhatsApp", GUIDE_ENTRIES).map((hit) => hit.entry.id);
    expect(ids[0]).toBe("channels");
  });
});

describe("guidePlainText", () => {
  it("keeps the words and drops the Markdown", () => {
    expect(
      guidePlainText("## A [link](x.md) and `code` with **bold**\n\n| a | b |\n|---|---|"),
    ).toBe("A link and code with bold a b");
  });
});
