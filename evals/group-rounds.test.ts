// T0: the group-round evaluation's configuration (ADR-0005 amendment 6, decision 52). The arms,
// their environment and order, and the rows `compare.ts` reads. Nothing here runs a model.

import { describe, expect, it } from "vitest";
import {
  GROUP_ROUND_ARMS,
  armEnvironment,
  armSchedule,
  groupRoundArm,
} from "../acceptance/support/group-round-arms.js";
import { parseResultFile } from "./compare/result-row.js";
import { type GroupOwnerReport, inputTokens, renderSchedule, toResultRow } from "./group-rounds.js";

describe("the three arms", () => {
  it("are parallel and in-turn on owner-v1 and the triaged round on round-v1", () => {
    expect(GROUP_ROUND_ARMS).toEqual([
      { arm: "parallel", groupRouting: "owner-v1", everyoneRoundMode: "parallel" },
      { arm: "in-turn", groupRouting: "owner-v1", everyoneRoundMode: "sequential" },
      { arm: "round-v1", groupRouting: "round-v1", everyoneRoundMode: "parallel" },
    ]);
    expect(armEnvironment("in-turn")).toEqual({
      DESKMATES_GROUP_ROUTING: "owner-v1",
      M2_GROUP_ROUND_ARM: "in-turn",
    });
  });

  it("follow the stack's routing when unset, and refuse an arm the stack cannot run", () => {
    expect(groupRoundArm(undefined, "owner-v1").arm).toBe("parallel");
    expect(groupRoundArm("", "round-v1").arm).toBe("round-v1");
    expect(groupRoundArm("in-turn", "owner-v1").everyoneRoundMode).toBe("sequential");
    expect(() => groupRoundArm("round-v1", "owner-v1")).toThrow(/DESKMATES_GROUP_ROUTING/);
    expect(() => groupRoundArm("walk", "owner-v1")).toThrow(/M2_GROUP_ROUND_ARM/);
  });

  it("rotate so no arm always runs first", () => {
    expect(armSchedule(3)).toEqual([
      ["parallel", "in-turn", "round-v1"],
      ["in-turn", "round-v1", "parallel"],
      ["round-v1", "parallel", "in-turn"],
    ]);
    expect(() => armSchedule(0)).toThrow();
    expect(renderSchedule(1)).toContain("round-v1: DESKMATES_GROUP_ROUTING=round-v1");
  });
});

describe("rows for compare.ts", () => {
  const report: GroupOwnerReport = {
    scenario: "everyone",
    routing: "round-v1",
    arm: "round-v1",
    passed: true,
    answered: true,
    totalRuns: 4,
    silentRuns: 1,
    failedRuns: 0,
    msToAnswer: 21000,
    msToFirstReply: 9000,
    botMessages: 3,
    triageRuns: 1,
    capBreaches: 0,
    runs: [
      {
        usage: [
          { model: "m", inputTokens: 1200 },
          { model: "c", inputTokens: 300 },
        ],
      },
      { usage: [{ model: "m" }] },
    ],
  };

  it("sum input tokens and carry the round fingerprint and the arm", () => {
    expect(inputTokens(report)).toBe(1500);
    const row = toResultRow(report, 2);
    expect(row).toMatchObject({
      taskId: "group-owner/everyone",
      bucket: "short",
      repeat: 2,
      success: true,
      arm: "round-v1",
      costUsd: null,
      fingerprint: {
        runs: 4,
        inputTokens: 1500,
        silentRuns: 1,
        botMessages: 3,
        triageRuns: 1,
        capBreaches: 0,
        msToAnswer: 21000,
        msToFirstReply: 9000,
      },
    });
    expect(parseResultFile(JSON.stringify(row))).toHaveLength(1);
  });

  it("leave an unanswered scenario's time out of the fingerprint and say why it failed", () => {
    const row = toResultRow(
      { ...report, passed: false, answered: false, msToAnswer: null, msToFirstReply: null },
      1,
    );
    expect(row.fingerprint).not.toHaveProperty("msToAnswer");
    expect(row.fingerprint).not.toHaveProperty("msToFirstReply");
    expect(row.failureReason).toBe("not_answered");
  });
});
