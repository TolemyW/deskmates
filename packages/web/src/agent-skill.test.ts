// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(new URL("../public/agent-skill/SKILL.md", import.meta.url), "utf8");

describe("served Deskmates agent skill", () => {
  it("installs independently and stops once when credentials are missing", () => {
    expect(skill).toContain("Installing this skill does not require that file");
    expect(skill).toMatch(/If it is missing or\s+has broader permissions, stop once/);
    expect(skill).toContain("mode `0600`");
  });

  it("keeps tokens out of chat and preserves TLS verification", () => {
    expect(skill).toContain("Do not ask the user to paste a token into chat");
    expect(skill).toContain("Never print it");
    expect(skill).toContain("Keep TLS certificate verification enabled");
    expect(skill).toContain("never silently add `-k`");
  });
});
