// T1 (ADR-0015 Verification row 7, Gateway half): every skill write is an immutable version;
// undo restores the previous version byte for byte; a human can move a skill to any stage; the
// skill set a run recorded is rebuilt exactly, and a resumed attempt gets that set back even after
// the skill changed. The replay half is `evals/replay.test.ts`.

import { type ProposedSkill, SKILL_STAGES, type WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryFixture, memoryFixture } from "../test-support/memory-fixture.js";
import { recordAuthoredSkills } from "./authoring.js";

const HUMAN = "human:user:owner";

let fx: MemoryFixture;
let ws: WorkspaceId;
beforeEach(async () => {
  fx = await memoryFixture();
  ws = fx.a.workspace.id;
});
afterEach(async () => {
  await fx.close();
});

function consolidationWrites(proposal: ProposedSkill) {
  const run = fx.ctx.runs.create({
    botId: fx.a.bot.id,
    lane: "background",
    triggerKind: "model_job",
    triggerRef: `consolidation-${Math.random()}`,
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
    { id: run.id, botId: fx.a.bot.id, workspaceId: ws, config: run.config },
    [proposal],
  );
  return outcome;
}

const v1: ProposedSkill = {
  name: "close-ticket",
  description: "Close a resolved ticket.",
  body: "1. Add the resolution note.\n2. Set the status to closed.",
};
const v2: ProposedSkill = { ...v1, body: `${v1.body}\n3. Notify the requester.` };

describe("versions (ADR-0015 decision 7)", () => {
  it("revises only a skill its bot used, as a new version", () => {
    const first = consolidationWrites(v1);
    expect(first?.outcome).toBe("stored");
    const skillId = first && "skillId" in first ? first.skillId : "";
    // Not used yet: the revision waits for a human.
    expect(consolidationWrites(v2)).toMatchObject({
      outcome: "held",
      reasons: ["revises_unused_skill"],
    });
    fx.ctx.skills.store.recordUse(skillId, fx.a.bot.id, new Date().toISOString());
    expect(consolidationWrites({ ...v2, body: `${v2.body}\n4. Done.` })).toMatchObject({
      outcome: "stored",
      version: 3,
    });
    expect(fx.ctx.skills.store.versions(skillId).map((v) => [v.version, v.op, v.review])).toEqual([
      [1, "author", "cleared"],
      [2, "revise", "pending"],
      [3, "revise", "cleared"],
    ]);
  });

  it("undo restores the previous version byte for byte as a new version", () => {
    const first = consolidationWrites(v1);
    const skillId = first && "skillId" in first ? first.skillId : "";
    fx.ctx.skills.store.recordUse(skillId, fx.a.bot.id, new Date().toISOString());
    consolidationWrites(v2);
    const before = fx.ctx.skills.store.version(skillId, 1);
    const undone = fx.ctx.skills.undo(ws, skillId, HUMAN);
    expect(undone.version).toBe(3);
    const restored = fx.ctx.skills.store.version(skillId, 3);
    expect(restored?.op).toBe("undo");
    expect(restored?.files).toEqual(before?.files);
    expect(restored?.sha256).toBe(before?.sha256);
    expect(JSON.stringify(restored?.files)).toBe(JSON.stringify(before?.files));
    // Nothing was rewritten: versions 1 and 2 are as they were.
    expect(fx.ctx.skills.store.version(skillId, 1)).toEqual(before);
    expect(fx.ctx.skills.store.versions(skillId)).toHaveLength(3);
    expect(() => fx.ctx.skills.undo(ws, skillId, "bot:x")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("lets a human move a skill to any stage", () => {
    const first = consolidationWrites(v1);
    const skillId = first && "skillId" in first ? first.skillId : "";
    for (const stage of [...SKILL_STAGES].reverse())
      expect(fx.ctx.skills.setStage(ws, skillId, stage, HUMAN).stage).toBe(stage);
  });

  it("rebuilds a recorded skill set exactly, and a resumed attempt keeps it", () => {
    const first = consolidationWrites(v1);
    const skillId = first && "skillId" in first ? first.skillId : "";
    const run = fx.ctx.runs.create({
      botId: fx.a.bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "cron:0",
      triggerPayload: { prompt: "go" },
      config: fx.ctx.runConfig(),
    });
    const { request } = fx.app.deskmates.lifecycle.start(run);
    const recorded = fx.ctx.runs.mustGet(run.id).config.skills as {
      set: { skillId: string; name: string; version: number; sha256: string }[];
    };
    // The skill moves on after the run started.
    fx.ctx.skills.store.recordUse(skillId, fx.a.bot.id, new Date().toISOString());
    consolidationWrites(v2);
    expect(fx.ctx.skills.store.mustGet(skillId).version).toBe(2);
    expect(fx.ctx.skills.rebuildSet(ws, recorded.set)).toEqual(request.skills);
    // A tampered or foreign reference is not rebuilt into some other set.
    const tampered = recorded.set.map((r) => ({ ...r, sha256: "0".repeat(64) }));
    expect(fx.ctx.skills.rebuildSet(ws, tampered)).toBeUndefined();
    expect(fx.ctx.skills.rebuildSet(fx.b.workspace.id, recorded.set)).toBeUndefined();

    // A later start of the same run row gets the recorded set, not the current version.
    fx.ctx.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").run(run.id);
    const again = fx.app.deskmates.lifecycle.start(fx.ctx.runs.mustGet(run.id));
    expect(again.request.skills).toEqual(request.skills);
  });
});
