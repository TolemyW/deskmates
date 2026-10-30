// T0: approval rule matching (ADR-0002 amendment 2, A3). Rules are per bot, every present
// matcher field must match, and the "Always" matcher is built so it holds across runs.

import { describe, expect, it } from "vitest";
import {
  ARGUMENT_TRUNCATION_MARKER,
  type ApprovalRule,
  type ApprovalRuleMatcher,
  type ToolAction,
  approvalRuleMatches,
  checkAlwaysRule,
  filePathPrefix,
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

/** The Always proposal for an action that has a stable target. */
function always(action: ToolAction): ApprovalRuleMatcher {
  const m = matcherFromAction(action);
  if (m === undefined) throw new Error("no stable target");
  return m;
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
    const m = always(submitClick);
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
    const m = always(submitClick);
    const { targetOrigin: _o, ...noOrigin } = submitClick;
    expect(approvalRuleMatches(rule(m), noOrigin, ALICE)).toBe(false);
    const { argumentSummary: _s, ...noArgs } = submitClick;
    expect(approvalRuleMatches(rule(m), noArgs, ALICE)).toBe(false);
  });

  it("holds across runs: a later click with different wording and ref still matches", () => {
    const m = always(submitClick);
    const later: ToolAction = {
      toolName: "mcp__browser__browser_click",
      input: { element: "button 'Submit'", ref: "e7" },
      targetOrigin: "http://shop.example.test:8080",
      argumentSummary: "button 'submit'",
      argumentPattern: "*submit*",
    };
    expect(approvalRuleMatches(rule(m), later, ALICE)).toBe(true);
  });

  it("keeps matching a rule stored before A6 from a verbatim summary, as it always did", () => {
    const shell: ToolAction = {
      toolName: "Bash",
      input: { command: "git push origin main" },
      argumentSummary: "git push origin main",
    };
    const legacy = rule({ toolName: "Bash", argumentPattern: "git push origin main" });
    expect(approvalRuleMatches(legacy, shell, ALICE)).toBe(true);
    expect(
      approvalRuleMatches(legacy, { ...shell, argumentSummary: "git push origin other" }, ALICE),
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

// ADR-0002 amendment 3, A6: Always proposes the tool plus a stable target, never the summary.
describe("matcherFromAction (A6 stable target)", () => {
  it("browser: the origin with the click's side-effect phrase, never the element wording", () => {
    expect(matcherFromAction(submitClick)).toEqual({
      toolName: "mcp__browser__browser_click",
      targetOrigin: "http://shop.example.test:8080",
      argumentPattern: "*submit*",
    });
  });

  it("browser and HTTP tools without a pattern: the origin alone", () => {
    const upload: ToolAction = {
      toolName: "mcp__browser__browser_file_upload",
      input: { paths: ["/work/a.pdf"] },
      targetOrigin: "https://forms.example.test",
      argumentSummary: "upload form",
    };
    expect(matcherFromAction(upload)).toEqual({
      toolName: "mcp__browser__browser_file_upload",
      targetOrigin: "https://forms.example.test",
    });
  });

  it("file tools: the directory prefix of the path", () => {
    const write: ToolAction = {
      toolName: "Write",
      input: { file_path: "/etc/deskmates/app.conf", content: "x" },
      filePath: "/etc/deskmates/app.conf",
      argumentSummary: "/etc/deskmates/app.conf",
    };
    const m = always(write);
    expect(m).toEqual({ toolName: "Write", filePath: "/etc/deskmates/" });
    const sibling = { ...write, filePath: "/etc/deskmates/other.conf" };
    expect(approvalRuleMatches(rule(m), sibling, ALICE)).toBe(true);
    expect(approvalRuleMatches(rule(m), { ...write, filePath: "/etc/passwd" }, ALICE)).toBe(false);
    expect(filePathPrefix("notes.md")).toBe("notes.md");
  });

  it("shell: the program and subcommand the sidecar derived", () => {
    const shell: ToolAction = {
      toolName: "Bash",
      input: { command: "git push origin feature/a" },
      argumentSummary: "git push origin feature/a",
      argumentPattern: "git push*",
    };
    const m = always(shell);
    expect(m).toEqual({ toolName: "Bash", argumentPattern: "git push*" });
    const later = { ...shell, argumentSummary: "git push origin feature/b --tags" };
    expect(approvalRuleMatches(rule(m), later, ALICE)).toBe(true);
  });

  it("subagent spawns: the agent type, whatever the description and prompt say", () => {
    const spawn: ToolAction = {
      toolName: "Agent",
      input: { subagent_type: "Explore", description: "map the repo", prompt: "long text" },
      argumentSummary: "agent Explore: map the repo",
      argumentPattern: "agent Explore: *",
    };
    const m = always(spawn);
    expect(m).toEqual({ toolName: "Agent", argumentPattern: "agent Explore: *" });
    const later = { ...spawn, argumentSummary: "agent Explore: find the tests" };
    expect(approvalRuleMatches(rule(m), later, ALICE)).toBe(true);
    const other = { ...spawn, argumentSummary: "agent general-purpose: map the repo" };
    expect(approvalRuleMatches(rule(m), other, ALICE)).toBe(false);
  });

  it("a free-text tool with no other target: the input hash, never the truncated summary", () => {
    const long = `{"to":"x","body":"${"y".repeat(300)}`;
    const send: ToolAction = {
      toolName: "SendMessage",
      input: { to: "x", body: "y".repeat(300) },
      argumentSummary: `${long.slice(0, 199)}${ARGUMENT_TRUNCATION_MARKER}`,
      inputSha256: "a".repeat(64),
    };
    const m = always(send);
    expect(m).toEqual({ toolName: "SendMessage", inputSha256: "a".repeat(64) });
    expect(m.argumentPattern).toBeUndefined();
    expect(approvalRuleMatches(rule(m), send, ALICE)).toBe(true);
    expect(approvalRuleMatches(rule(m), { ...send, inputSha256: "b".repeat(64) }, ALICE)).toBe(
      false,
    );
  });

  it("proposes nothing for an action recorded with only a summary", () => {
    const legacy: ToolAction = { toolName: "SendMessage", input: {}, argumentSummary: "{}" };
    expect(matcherFromAction(legacy)).toBeUndefined();
  });
});

describe("checkAlwaysRule (A6)", () => {
  const answers = { action: submitClick, botId: ALICE };

  it("accepts the proposal without a warning", () => {
    expect(checkAlwaysRule(always(submitClick), answers)).toEqual({ ok: true, warnings: [] });
  });

  it("accepts an edited matcher that still matches the action", () => {
    const edited = { ...always(submitClick), targetOrigin: "http://*.example.test:8080" };
    expect(checkAlwaysRule(edited, answers)).toEqual({ ok: true, warnings: [] });
  });

  it("refuses a pattern ending in the truncation marker", () => {
    const check = checkAlwaysRule({
      toolName: "Bash",
      argumentPattern: `npm run long${ARGUMENT_TRUNCATION_MARKER}`,
    });
    expect(check).toMatchObject({ ok: false, refusal: "rule_pattern_truncated" });
  });

  it("refuses a matcher that does not match the answered action", () => {
    const check = checkAlwaysRule({ ...always(submitClick), argumentPattern: "*cancel*" }, answers);
    expect(check).toMatchObject({ ok: false, refusal: "rule_does_not_match_action" });
  });

  it("warns on a free-text pattern without a wildcard, and on an input hash", () => {
    const exact = {
      toolName: "mcp__browser__browser_click",
      argumentPattern: "submit order button",
    };
    expect(checkAlwaysRule(exact, answers)).toEqual({ ok: true, warnings: ["exact_arguments"] });
    expect(checkAlwaysRule({ toolName: "X", inputSha256: "a".repeat(64) })).toEqual({
      ok: true,
      warnings: ["exact_input"],
    });
  });

  it("does not warn on the sidecar's own exact pattern for the action", () => {
    const integration: ToolAction = {
      toolName: "mcp__deskmates__integration_execute",
      input: {},
      argumentSummary: "integration:mail action:send",
      argumentPattern: "integration:mail action:send",
    };
    expect(checkAlwaysRule(always(integration), { action: integration, botId: ALICE })).toEqual({
      ok: true,
      warnings: [],
    });
  });
});
