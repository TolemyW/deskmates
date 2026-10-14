// T1 (ADR-0015 Verification rows 3 and 4, and the Gateway half of row 1). A provisional skill is
// in its author's skill set and in no other bot's; promotion without a compare result that meets
// the decision rule, or a human, is refused. An installed skill is pinned to its hash: new
// upstream content is a new install, never an in-place update, and a held install leaves the
// pinned version in force. A run's StartRunRequest carries exactly its skill set and
// `runs.config_json` names each skill and hash.

import { createHash } from "node:crypto";
import {
  type BotDefinition,
  type ProposedSkill,
  type SkillFile,
  type SkillPromotionEvidence,
  skillHashInput,
  skillMarkdown,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryFixture, memoryFixture } from "../test-support/memory-fixture.js";
import { recordAuthoredSkills } from "./authoring.js";

const HUMAN = "human:user:owner";

let fx: MemoryFixture;
let bob: BotDefinition;
beforeEach(async () => {
  fx = await memoryFixture();
  bob = fx.ctx.bots.create({ name: "bob", role: "test", workspaceId: fx.a.workspace.id });
});
afterEach(async () => {
  await fx.close();
});

const sha = (files: readonly SkillFile[]) =>
  createHash("sha256").update(skillHashInput(files)).digest("hex");

const PROPOSAL: ProposedSkill = {
  name: "triage-queue",
  description: "Triage the ticket queue by age.",
  body: "1. Sort by age.\n2. Label the oldest five.",
};

/** A cleared provisional skill authored by alice, as a qualifying consolidation stores it. */
function authored(): string {
  const run = fx.ctx.runs.create({
    botId: fx.a.bot.id,
    lane: "background",
    triggerKind: "cron",
    triggerRef: "consolidation",
    config: {
      runType: "memory_consolidation",
      skillAuthoring: {
        version: 1,
        minToolCalls: 10,
        episodes: [{ entryId: "mem_x", trust: "trusted", outcome: "succeeded", toolCalls: 12 }],
        usedSkills: [],
      },
    },
  });
  const [outcome] = recordAuthoredSkills(
    fx.ctx.skills,
    { id: run.id, botId: fx.a.bot.id, workspaceId: fx.a.workspace.id, config: run.config },
    [PROPOSAL],
  );
  if (outcome?.outcome !== "stored") throw new Error(`not stored: ${JSON.stringify(outcome)}`);
  return outcome.skillId;
}

const customSet = (workspaceId: typeof fx.a.workspace.id, botId: BotDefinition["id"]) =>
  fx.ctx.skills
    .skillSetFor(workspaceId, botId)
    .filter((skill) => !skill.skillId.startsWith("starter:"));
const names = (botId: BotDefinition["id"]) =>
  customSet(fx.a.workspace.id, botId).map((s) => s.name);

describe("Starter Skills (ADR-0015 amendment 1)", () => {
  it("gives every Bot the same release pack without install or assignment rows", () => {
    const forAlice = fx.ctx.skills
      .skillSetFor(fx.a.workspace.id, fx.a.bot.id)
      .filter((skill) => skill.skillId.startsWith("starter:"));
    const forBob = fx.ctx.skills
      .skillSetFor(fx.a.workspace.id, bob.id)
      .filter((skill) => skill.skillId.startsWith("starter:"));
    expect(forAlice).toEqual(forBob);
    expect(forAlice.map(({ name }) => name)).toContain("web-research-citations");
    expect(
      fx.ctx.db.prepare("SELECT COUNT(*) AS n FROM skills WHERE id LIKE 'starter:%'").get(),
    ).toEqual({ n: 0 });
    expect(
      fx.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM skill_assignments WHERE skill_id LIKE 'starter:%'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("reserves built-in names from third-party installation", () => {
    const files: SkillFile[] = [
      {
        path: "SKILL.md",
        content: skillMarkdown({
          name: "report-writing",
          description: "Attempt to shadow the built-in.",
          body: "Do something else.",
        }),
      },
    ];
    expect(() =>
      fx.ctx.skills.install(fx.a.workspace.id, { files, sha256: sha(files) }, HUMAN),
    ).toThrow(expect.objectContaining({ code: "validation" }));
  });
});

describe("stages (ADR-0015 decision 3)", () => {
  it("puts a provisional skill in its author's skill set and in no other bot's", () => {
    authored();
    expect(names(fx.a.bot.id)).toEqual(["triage-queue"]);
    expect(names(bob.id)).toEqual([]);
    expect(customSet(fx.b.workspace.id, fx.b.bot.id)).toEqual([]);
  });

  it("refuses promotion without a compare result or a human", () => {
    const id = authored();
    const skills = fx.ctx.skills;
    const ws = fx.a.workspace.id;
    expect(() => skills.promote(ws, id, { by: `bot:${fx.a.bot.id}` })).toThrow(
      expect.objectContaining({ code: "invalid_transition" }),
    );
    expect(() => skills.assign(ws, id, [bob.id], `bot:${fx.a.bot.id}`)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => skills.setStage(ws, id, "active", "system:sweep")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    const current = skills.store.mustGet(id).sha256 ?? "";
    const evidence = (over: Partial<SkillPromotionEvidence["compare"]>, hash = current) => ({
      sha256: hash,
      botIds: [bob.id],
      compare: { passes: true, verdict: "better" as const, pairedTasks: 44, ...over },
    });
    for (const bad of [
      evidence({ verdict: "inconclusive" }),
      evidence({ verdict: "no difference" }),
      evidence({ passes: false, verdict: "better" }),
      evidence({ pairedTasks: 0 }),
      evidence({}, "0".repeat(64)),
    ]) {
      expect(() => skills.promote(ws, id, { by: "eval:compare", evidence: bad })).toThrow(
        expect.objectContaining({ code: "invalid_transition" }),
      );
    }
    expect(skills.store.mustGet(id).stage).toBe("provisional");
    expect(names(bob.id)).toEqual([]);

    const promoted = skills.promote(ws, id, { by: "eval:compare", evidence: evidence({}) });
    expect(promoted.stage).toBe("active");
    expect(promoted.assignments).toEqual([
      expect.objectContaining({ botId: bob.id, basis: "evidence" }),
    ]);
    expect(names(bob.id)).toEqual(["triage-queue"]);
    expect(names(fx.a.bot.id)).toEqual(["triage-queue"]);
  });

  it("lets a human assign a provisional skill to other bots of its workspace only", () => {
    const id = authored();
    expect(() => fx.ctx.skills.assign(fx.a.workspace.id, id, [fx.b.bot.id], HUMAN)).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    const skill = fx.ctx.skills.assign(fx.a.workspace.id, id, [bob.id], HUMAN);
    expect(skill.stage).toBe("active");
    expect(skill.assignments).toEqual([expect.objectContaining({ botId: bob.id, basis: "human" })]);
    expect(names(bob.id)).toEqual(["triage-queue"]);
    // A skill never leaves its workspace.
    expect(() => fx.ctx.skills.mustGetIn(fx.b.workspace.id, id)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});

describe("install by hash (ADR-0015 decision 4)", () => {
  const files = (body: string): SkillFile[] => [
    {
      path: "SKILL.md",
      content: skillMarkdown({ name: "pdf-forms", description: "Fill PDF forms.", body }),
    },
  ];

  it("starts an installed skill active for the bots a human assigned", () => {
    const v1 = files("Open the form and fill each field.");
    const { skill, version } = fx.ctx.skills.install(
      fx.a.workspace.id,
      { files: v1, sha256: sha(v1), provenance: "clawhub:pdf-forms@1.0.0", botIds: [bob.id] },
      HUMAN,
    );
    expect(skill).toMatchObject({ origin: "installed", stage: "active", version: 1 });
    expect(skill.sha256).toBe(sha(v1));
    expect(version.review).toBe("cleared");
    expect(names(bob.id)).toEqual(["pdf-forms"]);
    expect(names(fx.a.bot.id)).toEqual([]);
  });

  it("refuses content that does not match the pinned hash, and installs only for humans", () => {
    const v1 = files("Open the form and fill each field.");
    expect(() =>
      fx.ctx.skills.install(fx.a.workspace.id, { files: v1, sha256: "0".repeat(64) }, HUMAN),
    ).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() =>
      fx.ctx.skills.install(fx.a.workspace.id, { files: v1, sha256: sha(v1) }, "bot:x"),
    ).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("does not update an installed skill in place when its upstream content changes", () => {
    const ws = fx.a.workspace.id;
    const v1 = files("Open the form and fill each field.");
    const first = fx.ctx.skills.install(
      ws,
      { files: v1, sha256: sha(v1), botIds: [bob.id] },
      HUMAN,
    );
    const before = fx.ctx.skills.store.version(first.skill.id, 1);
    // The same content again is the same install.
    fx.ctx.skills.install(ws, { files: v1, sha256: sha(v1) }, HUMAN);
    expect(fx.ctx.skills.store.versions(first.skill.id)).toHaveLength(1);

    // Upstream adds a script: a new install, held by the scan, and the pinned version stays.
    const v2 = [...files("Open the form and run the helper."), { path: "fill.py", content: "x" }];
    const second = fx.ctx.skills.install(ws, { files: v2, sha256: sha(v2) }, HUMAN);
    expect(second.version).toMatchObject({ version: 2, op: "install", review: "pending" });
    expect(fx.ctx.skills.store.version(first.skill.id, 1)).toEqual(before);
    expect(fx.ctx.skills.store.mustGet(first.skill.id)).toMatchObject({
      version: 1,
      sha256: sha(v1),
    });
    expect(customSet(ws, bob.id).map((s) => s.sha256)).toEqual([sha(v1)]);
    // The stored content is immutable at the database level as well.
    expect(() =>
      fx.ctx.db
        .prepare("UPDATE skill_versions SET files_json = '[]' WHERE skill_id = ? AND version = 1")
        .run(first.skill.id),
    ).toThrow(/immutable/);
    // A human confirms the new install; only then do runs receive it.
    fx.ctx.skills.confirm(ws, first.skill.id, 2, HUMAN);
    expect(customSet(ws, bob.id).map((s) => s.sha256)).toEqual([sha(v2)]);
    expect(fx.ctx.skills.store.version(first.skill.id, 1)).toEqual(before);
  });
});

describe("a run's skill set (ADR-0015 decision 1, Gateway half)", () => {
  it("hands the run exactly its set and records each skill and hash in runs.config_json", () => {
    authored();
    const v1 = files();
    fx.ctx.skills.install(
      fx.a.workspace.id,
      { files: v1, sha256: sha(v1), botIds: [bob.id] },
      HUMAN,
    );
    const run = fx.ctx.runs.create({
      botId: fx.a.bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "cron:0",
      triggerPayload: { prompt: "go" },
      config: fx.ctx.runConfig(),
    });
    const { request } = fx.app.deskmates.lifecycle.start(run);
    expect(request.skills?.map((s) => s.name)).toEqual(
      expect.arrayContaining(["web-research-citations", "triage-queue"]),
    );
    const recorded = fx.ctx.runs.mustGet(run.id).config.skills as {
      version: number;
      set: { skillId: string; name: string; version: number; sha256: string }[];
      starterPack: { version: string; sha256: string };
    };
    expect(recorded.version).toBe(1);
    expect(recorded.set).toEqual(
      request.skills?.map(({ skillId, name, version, sha256 }) => ({
        skillId,
        name,
        version,
        sha256,
      })),
    );
    expect(recorded.set[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.starterPack).toMatchObject({ version: "1.0.0" });
    expect(recorded.starterPack.sha256).toMatch(/^[0-9a-f]{64}$/);

    function files(): SkillFile[] {
      return [
        {
          path: "SKILL.md",
          content: skillMarkdown({ name: "pdf-forms", description: "Fill forms.", body: "Go." }),
        },
      ];
    }
  });
});
