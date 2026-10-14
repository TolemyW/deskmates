// T0: approval rule matching (ADR-0002 amendment 2, A3). Rules are per bot, every present
// matcher field must match, and the "Always" matcher is built so it holds across runs.

import { describe, expect, it } from "vitest";
import {
  type ApprovalRule,
  type ToolAction,
  approvalRuleMatches,
  findMatchingRule,
  globMatches,
  matcherFromAction,
} from "./approval.js";
import type { BotId } from "./ids.js";

const ALICE = "bot_alice" as BotId;
const BOB = "bot_bob" as BotId;

function rule(matcher: ApprovalRule["matcher"], botId: BotId = ALICE): ApprovalRule {
  return {
    id: "rule_1",
    botId,
    matcher,
    decision: "allow_always",
    createdBy: "human:web",
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

const submitClick: ToolAction = {
  toolName: "mcp__browser__browser_click",
  input: { element: "Submit order button", ref: "e42" },
  targetOrigin: "http://shop.example.test:8080",
  argumentSummary: "submit order button",
  argumentPattern: "*submit*",
};

describe("globMatches", () => {
  it("is literal without a star", () => {
    expect(globMatches("git push", "git push")).toBe(true);
    expect(globMatches("git push", "git push origin")).toBe(false);
  });
  it("lets a star match any run of characters, including none", () => {
    expect(globMatches("*submit*", "click the submit button")).toBe(true);
    expect(globMatches("*submit*", "submit")).toBe(true);
    expect(globMatches("git push*", "git push --force")).toBe(true);
    expect(globMatches("git push*", "git pull")).toBe(false);
    expect(globMatches("https://*.example.test", "https://shop.example.test")).toBe(true);
    expect(globMatches("https://*.example.test", "https://example.test")).toBe(false);
    expect(globMatches("a*b*c", "abc")).toBe(true);
    expect(globMatches("a*b*c", "axxbyyc")).toBe(true);
    expect(globMatches("a*b*c", "acb")).toBe(false);
  });
});

describe("approvalRuleMatches", () => {
  it("never answers another bot's action, even with an empty matcher", () => {
    expect(approvalRuleMatches(rule({}, BOB), submitClick, ALICE)).toBe(false);
    expect(approvalRuleMatches(rule({}, ALICE), submitClick, ALICE)).toBe(true);
  });

  it("requires every present field", () => {
    const m = matcherFromAction(submitClick);
    expect(approvalRuleMatches(rule(m), submitClick, ALICE)).toBe(true);
    expect(
      approvalRuleMatches(
        rule(m),
        { ...submitClick, toolName: "mcp__browser__browser_type" },
        ALICE,
      ),
    ).toBe(false);
    expect(
      approvalRuleMatches(rule(m), { ...submitClick, targetOrigin: "http://other.test" }, ALICE),
    ).toBe(false);
    expect(
      approvalRuleMatches(rule(m), { ...submitClick, argumentSummary: "cancel order" }, ALICE),
    ).toBe(false);
  });

  it("does not match when the action lacks a dimension the rule names", () => {
    const m = matcherFromAction(submitClick);
    const { targetOrigin: _o, ...noOrigin } = submitClick;
    expect(approvalRuleMatches(rule(m), noOrigin, ALICE)).toBe(false);
    const { argumentSummary: _s, ...noArgs } = submitClick;
    expect(approvalRuleMatches(rule(m), noArgs, ALICE)).toBe(false);
  });

  it("holds across runs: a later click with different wording and ref still matches", () => {
    const m = matcherFromAction(submitClick);
    const later: ToolAction = {
      toolName: "mcp__browser__browser_click",
      input: { element: "button 'Submit'", ref: "e7" },
      targetOrigin: "http://shop.example.test:8080",
      argumentSummary: "button 'submit'",
      argumentPattern: "*submit*",
    };
    expect(approvalRuleMatches(rule(m), later, ALICE)).toBe(true);
  });

  it("stores the summary verbatim when the sidecar gave no stable pattern", () => {
    const shell: ToolAction = {
      toolName: "Bash",
      input: { command: "git push origin main" },
      argumentSummary: "git push origin main",
    };
    expect(matcherFromAction(shell)).toEqual({
      toolName: "Bash",
      argumentPattern: "git push origin main",
    });
    expect(approvalRuleMatches(rule(matcherFromAction(shell)), shell, ALICE)).toBe(true);
    expect(
      approvalRuleMatches(
        rule(matcherFromAction(shell)),
        { ...shell, argumentSummary: "git push origin other" },
        ALICE,
      ),
    ).toBe(false);
  });

  it("checks origin globs, sql kind, amount ceiling and path prefix", () => {
    const action: ToolAction = {
      toolName: "db_exec",
      input: {},
      targetOrigin: "https://db.example.test",
      sqlStatementKind: "update",
      amount: 40,
      filePath: "/work/out/report.csv",
    };
    expect(
      approvalRuleMatches(rule({ targetOrigin: "https://*.example.test" }), action, ALICE),
    ).toBe(true);
    expect(approvalRuleMatches(rule({ sqlStatementKind: "delete" }), action, ALICE)).toBe(false);
    expect(approvalRuleMatches(rule({ maxAmount: 50 }), action, ALICE)).toBe(true);
    expect(approvalRuleMatches(rule({ maxAmount: 30 }), action, ALICE)).toBe(false);
    expect(approvalRuleMatches(rule({ filePath: "/work/out/" }), action, ALICE)).toBe(true);
    expect(approvalRuleMatches(rule({ filePath: "/work/out" }), action, ALICE)).toBe(false);
    expect(approvalRuleMatches(rule({ filePath: "/work/out/report.csv" }), action, ALICE)).toBe(
      true,
    );
  });

  it("findMatchingRule returns the first match in the given order", () => {
    const deny: ApprovalRule = { ...rule({ toolName: "Bash" }), id: "rule_deny", decision: "deny" };
    const allow: ApprovalRule = { ...rule({}), id: "rule_allow" };
    const shell: ToolAction = { toolName: "Bash", input: {} };
    expect(findMatchingRule([deny, allow], shell, ALICE)?.id).toBe("rule_deny");
    expect(findMatchingRule([allow, deny], shell, ALICE)?.id).toBe("rule_allow");
    expect(findMatchingRule([deny], submitClick, ALICE)).toBeUndefined();
  });
});
