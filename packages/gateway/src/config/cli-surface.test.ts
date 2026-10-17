// T0: the CLI surface knobs (ADR-0023 amendment 5, decision 24). Empty changes nothing, a value is
// validated at startup, the run row records the effective values, and a run reads them back from
// its own row.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliSurfaceStamp, cliSurfaceStart, readCliSurfaceConfig } from "./cli-surface.js";

const KEYS = [
  "DESKMATES_CLI_DISALLOWED_TOOLS",
  "DESKMATES_CLI_DISABLE_BUNDLED_SKILLS",
  "DESKMATES_CLI_INCLUDE_GIT_INSTRUCTIONS",
  "DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS",
];

describe("readCliSurfaceConfig", () => {
  it("changes nothing when every variable is empty or absent", () => {
    expect(readCliSurfaceConfig({})).toEqual({});
    expect(readCliSurfaceConfig(Object.fromEntries(KEYS.map((k) => [k, " "])))).toEqual({});
  });

  it("reads a tool list, the two switches and the description cap", () => {
    expect(
      readCliSurfaceConfig({
        DESKMATES_CLI_DISALLOWED_TOOLS: " NotebookEdit, TodoWrite ,NotebookEdit,",
        DESKMATES_CLI_DISABLE_BUNDLED_SKILLS: "true",
        DESKMATES_CLI_INCLUDE_GIT_INSTRUCTIONS: "FALSE",
        DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS: "200",
      }),
    ).toEqual({
      cliSurface: {
        disallowedTools: ["NotebookEdit", "TodoWrite"],
        disableBundledSkills: true,
        includeGitInstructions: false,
        skillListingMaxDescChars: 200,
      },
    });
  });

  it("refuses an MCP tool name, a word that is not a boolean and a cap that is not positive", () => {
    expect(() =>
      readCliSurfaceConfig({ DESKMATES_CLI_DISALLOWED_TOOLS: "mcp__browser__browser_click" }),
    ).toThrow(/DESKMATES_CLI_DISALLOWED_TOOLS/);
    expect(() => readCliSurfaceConfig({ DESKMATES_CLI_DISABLE_BUNDLED_SKILLS: "yes" })).toThrow(
      /DESKMATES_CLI_DISABLE_BUNDLED_SKILLS/,
    );
    expect(() => readCliSurfaceConfig({ DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS: "0" })).toThrow(
      /DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS/,
    );
  });

  it("is documented in .env.example with empty values", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const example = readFileSync(join(here, "../../../../.env.example"), "utf8");
    for (const key of KEYS) expect(example).toMatch(new RegExp(`^${key}=\\s`, "m"));
  });
});

describe("the run row stamp and the start request", () => {
  it("records nulls for the CLI's defaults and sends nothing back for them", () => {
    const stamp = cliSurfaceStamp({});
    expect(stamp).toEqual({
      cliSurface: {
        version: 1,
        disallowedTools: [],
        disableBundledSkills: null,
        includeGitInstructions: null,
        skillListingMaxDescChars: null,
      },
    });
    expect(cliSurfaceStart(stamp)).toEqual({});
    // A row from before the knob.
    expect(cliSurfaceStart({})).toEqual({});
  });

  it("round-trips configured values through the row", () => {
    const config = readCliSurfaceConfig({
      DESKMATES_CLI_DISALLOWED_TOOLS: "NotebookEdit",
      DESKMATES_CLI_INCLUDE_GIT_INSTRUCTIONS: "false",
    });
    expect(cliSurfaceStart(cliSurfaceStamp(config))).toEqual({
      cliSurface: { disallowedTools: ["NotebookEdit"], includeGitInstructions: false },
    });
  });

  it("drops a stored value of the wrong shape instead of forwarding it", () => {
    expect(
      cliSurfaceStart({
        cliSurface: {
          disallowedTools: ["Read", "mcp__x__y", 3],
          disableBundledSkills: "true",
          skillListingMaxDescChars: -5,
        },
      }),
    ).toEqual({ cliSurface: { disallowedTools: ["Read"] } });
  });
});
