// T1 (ADR-0015 Verification row 6, Gateway half): use is measured by the harness. Only a
// sidecar-originated `skill_used` event for a skill in the run's recorded set counts; a
// Gateway-originated one, or one naming a skill the run was not given, does not. With a fake
// clock, 14 days without use make a skill stale and 30 archived; a pinned skill stays; a human
// can restore an archived one. The sidecar half (the hook is the only source) is
// `packages/sidecar/src/skill-plugin.test.ts`.

import { createHash } from "node:crypto";
import {
  type BotDefinition,
  type SkillFile,
  skillHashInput,
  skillMarkdown,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryFixture, memoryFixture } from "../test-support/memory-fixture.js";

const HUMAN = "human:user:owner";
const DAY = 86_400_000;

let fx: MemoryFixture;
let bob: BotDefinition;
beforeEach(async () => {
  fx = await memoryFixture();
  bob = fx.ctx.bots.create({ name: "bob", role: "test", workspaceId: fx.a.workspace.id });
});
afterEach(async () => {
  await fx.close();
});

function install(name: string): string {
  const files: SkillFile[] = [
    { path: "SKILL.md", content: skillMarkdown({ name, description: `${name}.`, body: "Go." }) },
  ];
  const sha256 = createHash("sha256").update(skillHashInput(files)).digest("hex");
  return fx.ctx.skills.install(fx.a.workspace.id, { files, sha256, botIds: [bob.id] }, HUMAN).skill
    .id;
}

const stageOf = (id: string) => fx.ctx.skills.store.mustGet(id).stage;

describe("measured use and disuse (ADR-0015 decision 6)", () => {
  it("counts only hook events for the run's own skills and moves idle skills on a fake clock", () => {
    const used = install("used-skill");
    const idle = install("idle-skill");
    const pinned = install("pinned-skill");
    fx.ctx.skills.setPinned(fx.a.workspace.id, pinned, true, HUMAN);
    // The last install: every skill has been listed at least this long.
    const t0 = Date.parse(fx.ctx.skills.store.mustGet(pinned).listedSince);

    const run = fx.ctx.runs.create({
      botId: bob.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "cron:0",
      triggerPayload: { prompt: "go" },
      config: fx.ctx.runConfig(),
    });
    fx.app.deskmates.lifecycle.start(run);
    const at = (days: number) => new Date(t0 + days * DAY).toISOString();
    // The sidecar's hook: a sidecar seq marks it as the sidecar's own event.
    fx.ctx.events.append({
      runId: run.id,
      kind: "skill_used",
      payload: { skill: "used-skill" },
      seq: 1,
      attempt: 1,
      ts: at(5),
    });
    // Not from the hook: a Gateway-originated event, and a skill the run was never given.
    fx.ctx.events.append({
      runId: run.id,
      kind: "skill_used",
      payload: { skill: "idle-skill" },
      ts: at(20),
    });
    fx.ctx.events.append({
      runId: run.id,
      kind: "skill_used",
      payload: { skill: "elsewhere" },
      seq: 2,
      attempt: 1,
      ts: at(20),
    });
    expect(fx.ctx.skills.store.mustGet(used).lastUsedAt).toBe(at(5));
    expect(fx.ctx.skills.store.mustGet(idle).lastUsedAt).toBeUndefined();

    const sweep = (days: number) => fx.ctx.skills.sweep(new Date(t0 + days * DAY));
    sweep(13.9);
    expect([stageOf(used), stageOf(idle), stageOf(pinned)]).toEqual(["active", "active", "active"]);
    sweep(14);
    expect([stageOf(used), stageOf(idle), stageOf(pinned)]).toEqual(["active", "stale", "active"]);
    sweep(19);
    expect(stageOf(used)).toBe("stale");
    sweep(30);
    expect([stageOf(used), stageOf(idle), stageOf(pinned)]).toEqual([
      "stale",
      "archived",
      "active",
    ]);
    sweep(35);
    expect([stageOf(used), stageOf(idle), stageOf(pinned)]).toEqual([
      "archived",
      "archived",
      "active",
    ]);
    // Stale and archived skills are not listed; nothing was deleted.
    expect(
      fx.ctx.skills
        .skillSetFor(fx.a.workspace.id, bob.id, new Date(t0 + 35 * DAY))
        .filter((skill) => !skill.skillId.startsWith("starter:"))
        .map((s) => s.name),
    ).toEqual(["pinned-skill"]);
    expect(fx.ctx.skills.store.list(fx.a.workspace.id)).toHaveLength(3);
    // A human restores an archived skill.
    expect(fx.ctx.skills.setStage(fx.a.workspace.id, idle, "active", HUMAN).stage).toBe("active");
  });
});
