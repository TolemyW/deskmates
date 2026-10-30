// The matcher an Always decision stores (ADR-0002 amendment 3, A6): the stable target the
// contracts derive from the answered action, or the human's edit of it, checked before anything
// is stored. A refusal is a typed `validation` error whose `reason` is an `ApprovalRuleRefusal`;
// a warning is returned beside the stored rule.

import {
  type ApprovalRuleMatcher,
  type ApprovalRuleWarning,
  type BotId,
  DeskmatesError,
  type ToolAction,
  checkAlwaysRule,
  matcherFromAction,
} from "@deskmates/contracts";

export interface CheckedRuleMatcher {
  matcher: ApprovalRuleMatcher;
  warnings: ApprovalRuleWarning[];
}

/**
 * The matcher to store for an Always answer to `action`: `edited` when the human changed the
 * proposal, else the proposal itself. Refuses a matcher that does not match the action, one whose
 * pattern ends in the truncation marker, and an action with no stable target and no edit.
 */
export function alwaysRuleMatcher(
  action: ToolAction,
  botId: BotId,
  edited?: ApprovalRuleMatcher,
): CheckedRuleMatcher {
  const matcher = edited ?? matcherFromAction(action);
  if (matcher === undefined) {
    throw new DeskmatesError(
      "validation",
      "this action has no stable target to always allow; send the matcher to store",
      { reason: "rule_no_stable_target" },
    );
  }
  return checkedMatcher(matcher, { action, botId });
}

/** The same checks for a rule an operator types in or edits outside any approval. */
export function checkedRuleMatcher(matcher: ApprovalRuleMatcher): CheckedRuleMatcher {
  return checkedMatcher(matcher);
}

function checkedMatcher(
  matcher: ApprovalRuleMatcher,
  answers?: { action: ToolAction; botId: BotId },
): CheckedRuleMatcher {
  const check = checkAlwaysRule(matcher, answers);
  if (!check.ok) {
    throw new DeskmatesError("validation", check.message, {
      reason: check.refusal,
      field: "matcher",
    });
  }
  return { matcher, warnings: check.warnings };
}
