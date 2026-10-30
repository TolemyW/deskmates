// T0 (ADR-0048 decision 10): the default grouping rule's one exception is a documented property.
// The AGENTS.md rule an agent reads, the README and the user guide name the desktop-tools
// exception and its ADR, and none of them is left claiming the rule has no exception; the web
// section that shows the warning is tested in `web/src/features/desktop-tools`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").replace(/\s+/g, " ");

describe("the grouping exception for desktop workspaces (ADR-0048 decision 10)", () => {
  it("is named in the AGENTS.md grouping rule", () => {
    const agents = read("../../../../AGENTS.md");
    const rule = agents.slice(agents.indexOf("**Default grouping: one scenario, one workspace.**"));
    const bullet = rule.slice(0, rule.indexOf(" - **", 10));
    expect(bullet).toContain("The one exception");
    expect(bullet).toContain("ADR-0048 decision 10");
    expect(bullet).toContain("native desktop tools enabled");
    expect(bullet).toContain("on by default on an image that declares them");
    expect(bullet).toContain("its workspace page says so");
  });

  it.each([
    ["README.md", "../../../../README.md"],
    ["docs/guide/workspaces.md", "../../../../docs/guide/workspaces.md"],
    ["packages/gateway/docs/desktop-tools.md", "../../../gateway/docs/desktop-tools.md"],
  ])("is stated in %s", (_name, relative) => {
    const text = read(relative);
    expect(text).toContain("ADR-0048");
    expect(text).toMatch(/desktop tools/);
    expect(text).toMatch(/signed-in account/);
  });
});
