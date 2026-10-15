// T0/T1: the round triage job of ADR-0005 amendment 6, decision 45 (proposed). The answer is
// validated against the current members; the job starts while its bot's lane is busy.

import type { BotId, StartRunRequest } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { TRIAGE_TASK_MAX_CHARS, parseTriagePlan } from "./round-triage.js";

const members = [
  { botId: "bot_a" as BotId, name: "Ann" },
  { botId: "bot_b" as BotId, name: "ben" },
  { botId: "bot_c" as BotId, name: "cat" },
];

describe("parseTriagePlan", () => {
  it("keeps current members in order, case-insensitively and with a leading @", () => {
    expect(
      parseTriagePlan(
        '```json\n{"assignments":[{"member":"@ben","task":"price"},{"name":"ANN","task":"stock"}],"closer":"cat"}\n```',
        members,
      ),
    ).toEqual({
      ok: true,
      assignments: [
        { botId: "bot_b", task: "price" },
        { botId: "bot_a", task: "stock" },
      ],
      closerBotId: "bot_c",
    });
  });

  it("drops unknown names, repeated members and empty tasks, and bounds a task to one line", () => {
    const long = `${"x".repeat(TRIAGE_TASK_MAX_CHARS + 50)}`;
    const plan = parseTriagePlan(
      JSON.stringify({
        assignments: [
          { member: "zed", task: "anything" },
          { member: "ben", task: "first\nsecond   line" },
          { member: "ben", task: "again" },
          { member: "cat", task: "   " },
          { member: "Ann", task: long },
        ],
        closer: "ben",
      }),
      members,
    );
    expect(plan.ok && plan.assignments.map((a) => a.botId)).toEqual(["bot_b", "bot_a"]);
    expect(plan.ok && plan.assignments[0]?.task).toBe("first second line");
    expect(plan.ok && plan.assignments[1]?.task.length).toBe(TRIAGE_TASK_MAX_CHARS);
    expect(plan.ok && plan.assignments[1]?.task.endsWith("…")).toBe(true);
  });

  it("replaces a closer that is no member: the assigned owner, else the first assignee", () => {
    const answer = JSON.stringify({
      assignments: [
        { member: "ben", task: "price" },
        { member: "cat", task: "stock" },
      ],
      closer: "nobody",
    });
    expect(parseTriagePlan(answer, members, "bot_c" as BotId)).toMatchObject({
      closerBotId: "bot_c",
    });
    expect(parseTriagePlan(answer, members, "bot_a" as BotId)).toMatchObject({
      closerBotId: "bot_b",
    });
    expect(parseTriagePlan(answer, members)).toMatchObject({ closerBotId: "bot_b" });
  });

  it("fails on prose, broken JSON and a plan with no member", () => {
    expect(parseTriagePlan("ben should do it", members).ok).toBe(false);
    expect(parseTriagePlan('{"assignments": [', members).ok).toBe(false);
    expect(parseTriagePlan('{"assignments":[{"member":"zed","task":"x"}]}', members)).toEqual({
      ok: false,
      error: "triage assigned no member of the thread",
    });
  });
});

describe("the triage job and lanes", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("starts while its bot's background lane is held", async () => {
    h = await startHarness({ groupRouting: "round-v1" });
    const { ctx } = h.app.deskmates;
    const ws = ctx.workspaces.create({ name: "w", sandboxProvider: "docker" });
    const ann = ctx.bots.create({ name: "ann", role: "a", workspaceId: ws.id });
    const ben = ctx.bots.create({ name: "ben", role: "b", workspaceId: ws.id });
    const thread = ctx.threads.create({ workspaceId: ws.id, botIds: [ann.id, ben.id] });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      started.push(req);
      if (!req.modelJob) await hold;
      await gw.post("ended", { type: "run_ended", runId: req.runId, outcome: "failed", usage: [] });
    });
    const actor = ctx.runs.create({
      botId: ann.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "cron:test",
      triggerPayload: { prompt: "nightly" },
    });
    h.app.deskmates.scheduler.kick();
    await waitFor(() => started.some((r) => r.runId === actor.id), 2000, "actor started");
    const triage = ctx.router.postHuman({ threadId: thread.id, body: "anyone?" }).runs[0];
    expect(triage?.botId).toBe(ann.id);
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => started.some((r) => r.modelJob?.kind === "round_triage"),
      2000,
      "triage started beside the held lane",
    );
    release();
  });
});
