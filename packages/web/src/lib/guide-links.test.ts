// @vitest-environment node
// T0: links in the bundled manual (issue #28). A guide-relative link becomes internal navigation
// only when it names a manifest page; a repository path outside the guide becomes an explicit
// GitHub link at the release the UI was built from; anything else, including traversal out of
// the repository and every non-http(s) scheme, is not a link at all.

import { describe, expect, it } from "vitest";
import { createSlugger, resolveGuideImage, resolveGuideLink, slugify } from "./guide-links.js";

const at = (ref: string) => ({ sourceRef: ref });

describe("resolveGuideLink", () => {
  it("turns a guide page link into internal navigation", () => {
    expect(resolveGuideLink("tasks.md", "README", at("main"))).toEqual({
      kind: "topic",
      page: "tasks",
    });
    expect(resolveGuideLink("./bots.md", "tasks", at("main"))).toEqual({
      kind: "topic",
      page: "bots",
    });
    expect(resolveGuideLink("../guide/bots.md", "tasks", at("main"))).toEqual({
      kind: "topic",
      page: "bots",
    });
  });

  it("keeps an anchor, on another page or this one", () => {
    expect(resolveGuideLink("tasks.md#what-this-cannot-do", "README", at("main"))).toEqual({
      kind: "topic",
      page: "tasks",
      anchor: "what-this-cannot-do",
    });
    expect(resolveGuideLink("#pages", "README", at("main"))).toEqual({
      kind: "topic",
      page: "README",
      anchor: "pages",
    });
  });

  it("links a repository path outside the guide to the source at the built release", () => {
    expect(resolveGuideLink("../design/m4-status-2026-10-04.md", "README", at("v0.4.0"))).toEqual({
      kind: "repository",
      href: "https://github.com/TolemyW/deskmates/blob/v0.4.0/docs/design/m4-status-2026-10-04.md",
    });
    expect(resolveGuideLink("../../AGENTS.md", "README", at("main"))).toEqual({
      kind: "repository",
      href: "https://github.com/TolemyW/deskmates/blob/main/AGENTS.md",
    });
  });

  it("blocks a guide page the manifest does not have", () => {
    expect(resolveGuideLink("missing.md", "README", at("main"))).toEqual({ kind: "blocked" });
    expect(resolveGuideLink("constructor.md", "README", at("main"))).toEqual({ kind: "blocked" });
  });

  it("blocks traversal out of the repository and encoded or odd paths", () => {
    for (const href of [
      "../../../etc/passwd",
      "../../../../x.md",
      "/etc/passwd",
      "%2e%2e/%2e%2e/x.md",
      "tasks.md?x=1",
      "..\\..\\x.md",
      "tasks .md",
      "",
    ])
      expect(resolveGuideLink(href, "README", at("main")), href).toEqual({ kind: "blocked" });
  });

  it("allows http(s) destinations as external links and blocks every other scheme", () => {
    expect(resolveGuideLink("https://example.com/a?b=1", "README", at("main"))).toEqual({
      kind: "external",
      href: "https://example.com/a?b=1",
    });
    expect(resolveGuideLink("HTTP://example.com", "README", at("main"))).toEqual({
      kind: "external",
      href: "HTTP://example.com",
    });
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "mailto:someone@example.com",
      "//evil.example/x",
      "https:evil.example",
    ])
      expect(resolveGuideLink(href, "README", at("main")), href).toEqual({ kind: "blocked" });
  });
});

describe("resolveGuideImage", () => {
  it("resolves only assets the manifest lists", () => {
    const assets = { "screen.png": "/assets/screen-abc.png" };
    expect(resolveGuideImage("screen.png", assets)).toBe("/assets/screen-abc.png");
    expect(resolveGuideImage("./screen.png", assets)).toBe("/assets/screen-abc.png");
    expect(resolveGuideImage("other.png", assets)).toBeUndefined();
    expect(resolveGuideImage("../../packages/web/public/x.png", assets)).toBeUndefined();
    expect(resolveGuideImage("https://evil.example/x.png", assets)).toBeUndefined();
    expect(resolveGuideImage("data:image/png;base64,AAAA", assets)).toBeUndefined();
    expect(resolveGuideImage("toString", assets)).toBeUndefined();
  });
});

describe("slugify", () => {
  it("matches GitHub's heading anchors", () => {
    expect(slugify("What this cannot do")).toBe("what-this-cannot-do");
    expect(slugify("Allow once / Always / Deny")).toBe("allow-once--always--deny");
    expect(slugify("The `deskmates-agent-mcp` server")).toBe("the-deskmates-agent-mcp-server");
    expect(slugify("**Bold** [link](x.md)")).toBe("bold-link");
  });

  it("numbers repeated headings like GitHub", () => {
    const slug = createSlugger();
    expect(slug("Status")).toBe("status");
    expect(slug("Status")).toBe("status-1");
    expect(slug("Other")).toBe("other");
  });
});
