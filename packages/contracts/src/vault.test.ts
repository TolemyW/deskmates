// T0 (ADR-0045 decisions 1, 4 and 10): the Vault's contract invariants. A target is an exact
// public HTTPS origin; a release's stable dimension names the entry, revision and operation; an
// allow rule answers a release only when it binds tool, exact origin and that dimension exactly,
// and Always refuses a widened scope; the release tools are never tier-overridable; the tool
// inventory carries references only.

import { describe, expect, it } from "vitest";
import {
  type ApprovalRule,
  TOOL_TIER_OVERRIDE_EXCLUDED,
  type ToolAction,
  approvalRuleMatches,
  checkAlwaysRule,
  matcherFromAction,
} from "./approval.js";
import type { BotId } from "./ids.js";
import {
  VAULT_FILL_TOOL,
  VAULT_REQUEST_TOOL,
  VAULT_TOOL_NAMES,
  VAULT_USE_STATUSES,
  isVaultUseTool,
  vaultActionPattern,
  vaultOrigin,
} from "./vault.js";

const BOT = "bot_1" as BotId;
const pattern = vaultActionPattern({ entryId: "vlt_1", revision: 3, operation: "fill" });
const action: ToolAction = {
  toolName: VAULT_FILL_TOOL,
  input: { entryId: "vlt_1", revision: 3 },
  targetOrigin: "https://console.example.test",
  argumentSummary: pattern,
  argumentPattern: pattern,
};
const rule = (
  matcher: ApprovalRule["matcher"],
  decision: ApprovalRule["decision"] = "allow_always",
) =>
  ({ id: "r", botId: BOT, matcher, decision, createdBy: "human:t", createdAt: "" }) as ApprovalRule;

describe("vault contract", () => {
  it("accepts only an exact public https origin", () => {
    expect(vaultOrigin("https://console.example.test")).toBe("https://console.example.test");
    expect(vaultOrigin("https://console.example.test/")).toBe("https://console.example.test");
    expect(vaultOrigin("https://console.example.test:8443")).toBe(
      "https://console.example.test:8443",
    );
    for (const bad of [
      "http://console.example.test",
      "https://console.example.test/login",
      "https://user:pw@console.example.test",
      "https://10.0.0.5",
      "https://localhost",
      "https://console.example.test?x=1",
      "javascript:alert(1)",
    ])
      expect(vaultOrigin(bad)).toBeUndefined();
  });

  it("names entry, revision and operation in the release dimension", () => {
    expect(pattern).toBe("vault:vlt_1 rev:3 op:fill");
    expect(
      vaultActionPattern({
        entryId: "vlt_1",
        revision: 3,
        operation: "request",
        requestId: "vrq_9",
      }),
    ).toBe("vault:vlt_1 rev:3 op:request:vrq_9");
  });

  it("lets only an exactly bound allow rule answer a release; a deny rule still matches", () => {
    expect(approvalRuleMatches(rule({ toolName: VAULT_FILL_TOOL }), action, BOT)).toBe(false);
    expect(
      approvalRuleMatches(
        rule({
          toolName: VAULT_FILL_TOOL,
          targetOrigin: "https://*.example.test",
          argumentPattern: "vault:vlt_1 *",
        }),
        action,
        BOT,
      ),
    ).toBe(false);
    expect(
      approvalRuleMatches(rule({ targetOrigin: action.targetOrigin as string }), action, BOT),
    ).toBe(false);
    const exact = matcherFromAction(action);
    expect(exact).toEqual({
      toolName: VAULT_FILL_TOOL,
      targetOrigin: "https://console.example.test",
      argumentPattern: pattern,
    });
    expect(approvalRuleMatches(rule(exact ?? {}), action, BOT)).toBe(true);
    const nextRevision = vaultActionPattern({ entryId: "vlt_1", revision: 4, operation: "fill" });
    expect(
      approvalRuleMatches(
        rule(exact ?? {}),
        { ...action, argumentSummary: nextRevision, argumentPattern: nextRevision },
        BOT,
      ),
    ).toBe(false);
    expect(approvalRuleMatches(rule({ toolName: VAULT_FILL_TOOL }, "deny"), action, BOT)).toBe(
      true,
    );
  });

  it("refuses a widened Always scope for a release", () => {
    expect(checkAlwaysRule(matcherFromAction(action) ?? {}, { action, botId: BOT })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(
      checkAlwaysRule(
        { toolName: VAULT_FILL_TOOL, argumentPattern: "vault:vlt_1 *" },
        { action, botId: BOT },
      ),
    ).toMatchObject({ ok: false, refusal: "rule_vault_not_exact" });
  });

  it("keeps the release tools out of tier overrides and lists only reference tools", () => {
    expect(TOOL_TIER_OVERRIDE_EXCLUDED).toEqual(
      expect.arrayContaining([VAULT_FILL_TOOL, VAULT_REQUEST_TOOL]),
    );
    expect(isVaultUseTool(VAULT_FILL_TOOL) && isVaultUseTool(VAULT_REQUEST_TOOL)).toBe(true);
    expect(isVaultUseTool("mcp__deskmates__vault_list")).toBe(false);
    // Decision 10: no tool reads, reveals, exports or injects a value.
    expect([...VAULT_TOOL_NAMES]).toEqual(["vault_list", "vault_fill", "vault_request"]);
    expect(VAULT_USE_STATUSES).toContain("unknown");
    expect(VAULT_USE_STATUSES).not.toContain("logged_in");
  });
});
