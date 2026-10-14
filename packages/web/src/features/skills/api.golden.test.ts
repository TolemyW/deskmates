// T0 wire golden for the skills API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type SkillsApi, createSkillsApi } from "./api.js";

const CASES: GoldenCases<SkillsApi> = {
  assignSkill: (a) => a.assignSkill("skill/1", [BOT]),
  confirmSkillVersion: (a) => a.confirmSkillVersion("skill/1", 3),
  installSkill: (a) =>
    a.installSkill(WS, {
      files: [{ path: "SKILL.md", content: "# s" }],
      sha256: "abc",
      botIds: [BOT],
    }),
  listPendingSkillVersions: (a) => a.listPendingSkillVersions(WS, { cursor: "c1", limit: 25 }),
  listSkillVersions: (a) => a.listSkillVersions("skill/1", { cursor: "c2" }),
  listSkills: (a) => a.listSkills(WS, { q: "tax forms", offset: 25, limit: 25 }),
  rejectSkillVersion: (a) => a.rejectSkillVersion("skill/1", 3),
  undoSkill: (a) => a.undoSkill("skill/1"),
  updateSkill: (a) => a.updateSkill("skill/1", { pinned: true }),
};

describe("skills API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createSkillsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
