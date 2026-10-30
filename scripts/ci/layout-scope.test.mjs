import { describe, expect, it } from "vitest";
import { layoutScope } from "./layout-scope.mjs";

const channel = "packages/web/src/features/integrations/channel-connections.tsx";
describe("CI layout scope", () => {
  it("checks all variants of the changed feature, including mixed backend and prose edits", () => {
    expect(layoutScope([channel, "AGENTS.md", "packages/channels/src/wechat/plugin.ts"])).toBe(
      "integrations",
    );
    expect(layoutScope([channel, "packages/web/src/features/contacts/screen.tsx"])).toBe(
      "contacts,integrations",
    );
  });
  it.each([
    "packages/ui/src/button.tsx",
    "packages/web/src/components/tabs.tsx",
    "packages/web/src/app.tsx",
    "packages/web/scripts/check-tab-layout.mjs",
    "packages/web/src/features/integrations/styles.css",
    "docs/guide/connections.md",
    "package-lock.json",
    "vitest.config.ts",
  ])("keeps the complete gate for shared inputs: %s", (file) => {
    expect(layoutScope([channel, file])).toBe("");
  });
  it("keeps the complete gate for manual runs and missing fixtures", () => {
    expect(layoutScope([channel], "workflow_dispatch")).toBe("");
    expect(layoutScope([channel], "pull_request", () => false)).toBe("");
    expect(layoutScope([], "pull_request")).toBe("");
  });
});
