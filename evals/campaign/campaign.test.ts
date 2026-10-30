// T0: the shared campaign helpers of the 2026-10-17 protocol: answer extraction and
// normalisation, the FTS5 token rule, seeded filler, cost ceilings, the stop rules, and the
// campaign gate of amendment 1 (one ceiling per campaign, none for known zero).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelPrice } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { ceilingOf, centsUp, checkStopRules } from "./ceiling.js";
import {
  CAMPAIGN_PIN_FILE,
  authoriseCampaign,
  campaignGate,
  firstBatchFirst,
  knownZero,
  pinCampaign,
} from "./gate.js";
import {
  answerOf,
  containsTokens,
  contentTokens,
  fillerParagraph,
  normalizeAnswer,
  seeded,
  tokens,
} from "./text.js";

describe("answers", () => {
  it("are the last answer line, with emphasis, quotes, a full stop and separators normalised", () => {
    expect(answerOf("first\nanswer: 1\nmore\nAnswer:  **3,550**.")).toBe("**3,550**.");
    expect(normalizeAnswer("**3,550**.")).toBe("3550");
    expect(normalizeAnswer(" `Heron   Desk` ")).toBe("heron desk");
    expect(answerOf("答案\nanswer：北辰物流")).toBe("北辰物流");
    expect(answerOf("no answer line")).toBeUndefined();
  });
});

describe("tokens", () => {
  it("follow the FTS5 query rule and keep a CJK run whole", () => {
    expect(tokens("E-4127 is raised by ledger-sync")).toEqual([
      "e",
      "4127",
      "is",
      "raised",
      "by",
      "ledger",
      "sync",
    ]);
    expect(tokens("冷链货物统一交给北辰物流配送。")).toEqual(["冷链货物统一交给北辰物流配送"]);
    expect([...contentTokens("Which desk owns the runbook?")]).toEqual(["desk", "owns", "runbook"]);
    expect(containsTokens("listens on port 9184 inside", "9184")).toBe(true);
    expect(containsTokens("port 91840", "9184")).toBe(false);
    expect(containsTokens("交给北辰物流配送", "北辰物流")).toBe(true);
  });
});

describe("filler", () => {
  it("is seeded and bounded", () => {
    const a = seeded(7);
    const b = seeded(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const p = fillerParagraph(500, 3);
    expect(p.length).toBeLessThanOrEqual(500);
    expect(p.length).toBeGreaterThan(400);
    expect(fillerParagraph(500, 3)).toBe(p);
  });
});

describe("ceilings and stop rules", () => {
  const cap = () => 0.1;
  const obs = (cost: number | null, over: Record<string, unknown> = {}) => ({
    taskId: "T",
    arm: "a",
    repeat: 1,
    costUsd: cost,
    ...over,
  });

  it("price runs × cap, rounded up to whole cents", () => {
    expect(centsUp(0.101)).toBe(0.11);
    expect(centsUp(2.4)).toBe(2.4);
    expect(
      ceilingOf([
        { label: "x", runs: 3, perRunUsd: 0.1 },
        { label: "y", runs: 1, perRunUsd: 0.005 },
      ]).totalUsd,
    ).toBe(0.31);
  });

  it("run on while spend and the next run's cap fit under the ceiling", () => {
    expect(
      checkStopRules({
        ceilingUsd: 1,
        perRunCapUsd: cap,
        observations: [obs(0.05), obs(0.06)],
        next: "T",
      }),
    ).toEqual({ stop: false, spentUsd: 0.11 });
  });

  it("stop on the ceiling (S1), an unknown cost (S2), a harness error (S3), a run over twice its cap (S4) and the canary (S5)", () => {
    const rule = (observations: ReturnType<typeof obs>[], next?: string) =>
      checkStopRules({
        ceilingUsd: 0.3,
        perRunCapUsd: cap,
        observations,
        ...(next ? { next } : {}),
      }).rule;
    expect(rule([obs(0.1), obs(0.1)], "T")).toBe("S1_ceiling");
    expect(rule([obs(0.1), obs(null)])).toBe("S2_unknown_cost");
    expect(rule([obs(0.1, { leakUsd: null })])).toBe("S2_unknown_cost");
    expect(rule([obs(0.1, { harnessError: "seed" })])).toBe("S3_harness_error");
    expect(rule([obs(0.25)])).toBe("S4_run_over_cap");
    expect(rule([obs(0.01, { canarySeen: true })])).toBe("S5_safety_canary");
  });
});

describe("ceilings and stop rules across one campaign (amendment 1)", () => {
  const cap = () => 0.1;
  const obs = (cost: number | null, arm: string, repeat: number) => ({
    taskId: "T",
    arm,
    repeat,
    costUsd: cost,
  });

  it("sum every arm and block against the one ceiling", () => {
    const observations = [obs(0.1, "fts5", 1), obs(0.1, "vectors", 1), obs(0.05, "fts5", 2)];
    expect(checkStopRules({ ceilingUsd: 0.4, perRunCapUsd: cap, observations, next: "T" })).toEqual(
      { stop: false, spentUsd: 0.25 },
    );
    // A block that alone would fit stops because the campaign as a whole does not.
    expect(
      checkStopRules({
        ceilingUsd: 0.3,
        perRunCapUsd: cap,
        observations: [...observations, obs(0.01, "vectors", 2)],
        next: "T",
      }).rule,
    ).toBe("S1_ceiling");
  });

  it("let a known-zero campaign run on zero, holding no reserve, and stop it on any priced spend or unknown cost", () => {
    const zero = [obs(0, "a", 1), obs(0, "b", 1)];
    expect(
      checkStopRules({ ceilingUsd: null, perRunCapUsd: cap, observations: zero, next: "T" }),
    ).toEqual({ stop: false, spentUsd: 0 });
    expect(
      checkStopRules({
        ceilingUsd: null,
        perRunCapUsd: cap,
        observations: [...zero, obs(0.0001, "b", 2)],
      }).rule,
    ).toBe("S1_ceiling");
    expect(
      checkStopRules({
        ceilingUsd: null,
        perRunCapUsd: cap,
        observations: [...zero, obs(null, "a", 2)],
      }).rule,
    ).toBe("S2_unknown_cost");
    expect(
      checkStopRules({
        ceilingUsd: null,
        perRunCapUsd: cap,
        observations: [{ ...obs(0, "a", 2), leakUsd: null }],
      }).rule,
    ).toBe("S2_unknown_cost");
  });
});

describe("the campaign gate (amendment 1)", () => {
  const price = (model: string, rate: number): ModelPrice => ({
    model,
    inputPerM: rate,
    outputPerM: rate,
    cacheReadPerM: 0,
    cacheCreatePerM: 0,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  });
  const local = price("local-a", 0);
  const local2 = price("local-b", 0);
  const paid = price("paid-a", 3);

  it("calls a model known zero only when it has rows and every rate of every row is zero", () => {
    expect(knownZero("local-a", [local])).toBe(true);
    expect(knownZero("absent", [local])).toBe(false);
    expect(knownZero("paid-a", [paid])).toBe(false);
    expect(knownZero("local-a", [local, { ...local, cacheReadPerM: 0.01 }])).toBe(false);
    expect(knownZero("local-a", [{ ...local, cacheCreatePerM: 1 }])).toBe(false);
  });

  it("starts a known-zero campaign without a ceiling", () => {
    expect(campaignGate({}, ["local-a", "local-b", "local-a"], [local, local2])).toEqual({
      ceilingUsd: null,
      paidModels: [],
    });
    expect(campaignGate({ EVAL_CEILING_USD: " " }, ["local-a"], [local]).ceilingUsd).toBeNull();
  });

  it("refuses a paid campaign without a ceiling, also when only one arm's model is paid", () => {
    expect(() => campaignGate({}, ["paid-a"], [paid])).toThrow(
      /EVAL_CEILING_USD is required: paid-a/,
    );
    expect(() => campaignGate({}, ["local-a", "paid-a", "local-b"], [local, local2, paid])).toThrow(
      /EVAL_CEILING_USD is required: paid-a is not priced as known zero/,
    );
  });

  it("starts a paid campaign under the one authorised ceiling", () => {
    expect(campaignGate({ EVAL_CEILING_USD: "24" }, ["local-a", "paid-a"], [local, paid])).toEqual({
      ceilingUsd: 24,
      paidModels: ["paid-a"],
    });
  });

  it("refuses an unpriced model and a malformed ceiling whatever else is set", () => {
    expect(() => campaignGate({ EVAL_CEILING_USD: "24" }, ["absent"], [local])).toThrow(
      /no MODEL_PRICES row for absent/,
    );
    for (const bad of ["0", "-1", "abc", "Infinity"])
      expect(() => campaignGate({ EVAL_CEILING_USD: bad }, ["paid-a"], [paid])).toThrow(
        /EVAL_CEILING_USD must be/,
      );
    expect(() => campaignGate({}, ["", " "], [local])).toThrow(/names no model/);
  });

  const dir = () => mkdtempSync(path.join(tmpdir(), "campaign-gate-"));
  const pin = {
    campaign: "cheap-model-v1",
    taskSet: "cheap-model@1.0.0",
    mode: "model" as const,
    ceilingUsd: 24,
  };

  it("pins one ceiling per campaign: every later invocation must name the same one", () => {
    const reportDir = dir();
    pinCampaign(reportDir, pin);
    pinCampaign(reportDir, pin);
    expect(() => pinCampaign(reportDir, { ...pin, ceilingUsd: 30 })).toThrow(
      /pins ceilingUsd 24; this invocation has 30\. One campaign has one ceiling/,
    );
    expect(() => pinCampaign(reportDir, { ...pin, ceilingUsd: null })).toThrow(/ceilingUsd/);
    expect(() => pinCampaign(reportDir, { ...pin, mode: "scripted" })).toThrow(/mode/);
    expect(() => pinCampaign(reportDir, { ...pin, taskSet: "cheap-model@1.1.0" })).toThrow(
      /taskSet/,
    );
  });

  it("refuses a report directory that holds observations but no pin", () => {
    const reportDir = dir();
    writeFileSync(path.join(reportDir, "AS-01@small__incumbent__r1.json"), "{}\n");
    expect(() => pinCampaign(reportDir, pin)).toThrow(/holds observations but no campaign\.meta/);
  });

  it("authorises each invocation against the same pin, across arms and blocks", () => {
    const reportDir = dir();
    const env = (arm: string, repeat: number, ceiling?: string) => ({
      EVAL_ARM: arm,
      EVAL_REPEAT: String(repeat),
      EVAL_REPORT_DIR: reportDir,
      ...(ceiling ? { EVAL_CEILING_USD: ceiling } : {}),
    });
    const input = {
      campaign: "cheap-model-v1",
      taskSet: "cheap-model@1.0.0",
      mode: "model" as const,
      models: ["local-a", "paid-a"],
      prices: [local, paid],
    };
    expect(authoriseCampaign(env("incumbent", 1, "24"), input)).toEqual({
      arm: "incumbent",
      repeat: 1,
      reportDir,
      ceilingUsd: 24,
    });
    expect(authoriseCampaign(env("candidate", 1, "24"), input).ceilingUsd).toBe(24);
    // A second phase with its own ceiling is no longer a thing: a new ceiling is refused.
    expect(() => authoriseCampaign(env("candidate", 2, "48"), input)).toThrow(/one ceiling/);
    expect(() => authoriseCampaign(env("candidate", 2), input)).toThrow(
      /EVAL_CEILING_USD is required/,
    );
    expect(() => authoriseCampaign({ ...env("x", 0, "24") }, input)).toThrow(/EVAL_REPEAT/);
    expect(() =>
      authoriseCampaign({ EVAL_REPEAT: "1", EVAL_REPORT_DIR: reportDir }, input),
    ).toThrow(/EVAL_ARM/);
    const zeroDir = dir();
    expect(
      authoriseCampaign(
        { EVAL_ARM: "fts5", EVAL_REPEAT: "1", EVAL_REPORT_DIR: zeroDir },
        { ...input, campaign: "retrieval-v1", models: ["local-a"], prices: [local] },
      ).ceilingUsd,
    ).toBeNull();
    expect(CAMPAIGN_PIN_FILE.endsWith(".json")).toBe(false);
  });
});

describe("the first batch (amendment 1)", () => {
  it("runs first in block 1, keeping the seeded order, and changes no other block", () => {
    const order = ["a", "B", "c", "D", "e"];
    const first = (x: string) => x === x.toUpperCase();
    expect(firstBatchFirst(order, first, 1)).toEqual(["B", "D", "a", "c", "e"]);
    expect(firstBatchFirst(order, first, 2)).toEqual(order);
    expect(firstBatchFirst(order, first, 5)).toEqual(order);
  });
});
