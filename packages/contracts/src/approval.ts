// Risk tiers and approvals (design v0.3 §3.5, ADR-0002 decision 2).

import type { ApprovalId, BotId, IsoTimestamp, MessageId, RunId, ThreadId } from "./ids.js";
import { isVaultUseTool } from "./vault.js";

/** L0 read-only, L1 reversible write, L2 external side effect. */
export type RiskLevel = "L0" | "L1" | "L2";

/** What the sidecar's PreToolUse hook returns to the SDK. `defer` parks the run (ADR-0002). */
export type HookDecision = "allow" | "deny" | "defer";

export type ApprovalDecision = "allow_once" | "allow_always" | "deny";

/** `live`: the PreToolUse hook blocked and a human answered in time. `deferred`: the run was parked. */
export type WaitMode = "live" | "deferred";

/** Short-wait timeout before the hook defers, in seconds (ADR-0002 decision 2). */
export const SHORT_WAIT_SECONDS_DEFAULT = 300;

/** A human is "online" if a client heartbeat or subscription is younger than this (ADR-0002 definitions). */
export const HUMAN_ONLINE_WINDOW_SECONDS = 60;

/** The tool call being judged, as the hook sees it. */
export interface ToolAction {
  toolName: string;
  /** Raw tool input; the shape depends on the tool. */
  input: Record<string, unknown>;
  /** Derived at classification time so rules can match on it without re-parsing input. */
  targetOrigin?: string;
  /**
   * One line that names the arguments a rule may match on, derived by the sidecar: the shell
   * command for `Bash`, the element text or ref for a browser click, the URL for navigation, the
   * path for a file write. Never tool output.
   */
  argumentSummary?: string;
  /**
   * The glob an "Always" decision stores for this action, derived by the sidecar so it is stable
   * across runs: a browser click's element description changes wording and its `ref` changes on
   * every snapshot, so the pattern keeps only the side-effect phrase that made the click L2
   * (`*submit*`); a shell command keeps its program and subcommand (`git push*`). Absent means
   * the rule stores `argumentSummary` verbatim.
   */
  argumentPattern?: string;
  sqlStatementKind?: "select" | "insert" | "update" | "delete" | "ddl" | "other";
  amount?: number;
  filePath?: string;
  /**
   * SHA-256 (lower-case hex) of the tool input as the model gave it, set by the sidecar only when
   * the action has no other stable target: no `argumentPattern`, no `filePath` and no
   * `targetOrigin`. It is what an Always rule for such a tool binds to, because the summary of a
   * free-text input is not stable and may be truncated (ADR-0002 amendment 3, A6).
   */
  inputSha256?: string;
  /**
   * The subagent type (`general-purpose`, `Explore`, ...) when the call was made inside a
   * subagent the run spawned: the hook input carried `agent_id` (ADR-0002 amendment 3, A5).
   * Display only; never a rule dimension.
   */
  agentType?: string;
  /**
   * The tool is in none of the sidecar's tier tables, so it is L2 by the fail-closed default
   * rather than by a deliberate tier (ADR-0002 amendment 3, A5). Display only.
   */
  unclassified?: true;
}

export interface Approval {
  /** Advisory display only; never changes the action or its matching dimensions. */
  displaySummary?: { text: string; runId: RunId };
  id: ApprovalId;
  /**
   * `tool`: an L2 call. `continuation`: a turn-budget decision; never creates a tool rule.
   * `egress`: a navigation to a public host outside the workspace allowlist (ADR-0020); an
   * `allow_always` adds the host to the allowlist instead of creating a tool rule, and there is
   * no `allow_once`, because the managed proxy enforces the same list.
   */
  kind?: "tool" | "continuation" | "egress";
  runId: RunId;
  /** The bot whose run asked; rules are stored per bot. */
  botId: BotId;
  /** The thread the request was posted in; absent for a run with no thread (cron, webhook). */
  threadId?: ThreadId;
  /** The `system` message in that thread that carries the request (ADR-0002 amendment 2, A1). */
  messageId?: MessageId;
  action: ToolAction;
  riskLevel: RiskLevel;
  /** SDK tool-use id of the call; a resumed run applies the decision to this call only. */
  toolUseId?: string;
  /** The human's original instruction, the message that woke the run. Never page content. */
  instruction?: string;
  decision?: ApprovalDecision;
  /** `human:<authorId>`, `bot:<botId>` or `rule:<ruleId>`; see `decidedByHuman` and friends. */
  decidedBy?: string;
  decidedAt?: IsoTimestamp;
  /** Free text from the decider, shown to the bot as the deny reason. */
  reason?: string;
  waitMode: WaitMode;
  createdAt: IsoTimestamp;
}

/** Who settled an approval, as stored in `decidedBy` (ADR-0002 amendment 2, A2). */
export function decidedByHuman(authorId: string): string {
  return `human:${authorId}`;
}
export function decidedByBot(botId: BotId): string {
  return `bot:${botId}`;
}
export function decidedByRule(ruleId: string): string {
  return `rule:${ruleId}`;
}

/**
 * MIME type of the attachment that links a thread `system` message to its approval: the message
 * body is the human-readable request, the attachment `ref` is the `ApprovalId`. The UI joins the
 * two to draw the card inline (ADR-0002 amendment 2, A1).
 */
export const APPROVAL_ATTACHMENT_MIME = "application/vnd.deskmates.approval+json";

/**
 * Read historical append-only messages without changing the format of new writes. The vendor
 * segment of the type carried each former product name, so a message written under any of them
 * is still an approval link; the shape `application/vnd.<vendor>.approval+json` is the contract.
 */
const LEGACY_APPROVAL_ATTACHMENT_MIME = /^application\/vnd\.[a-z0-9-]+\.approval\+json$/;

export function isApprovalAttachmentMime(mimeType: string): boolean {
  return mimeType === APPROVAL_ATTACHMENT_MIME || LEGACY_APPROVAL_ATTACHMENT_MIME.test(mimeType);
}

/**
 * Matcher for a stored approval rule. Every present field must match; absent fields match anything.
 * A rule created from an "Always allow" decision copies the dimensions of that action: tool name,
 * target origin and the argument summary (ADR-0002 amendment 2, A3).
 */
export interface ApprovalRuleMatcher {
  toolName?: string;
  /** Exact origin, or a glob where `*` matches any run of characters (`https://*.example.test`). */
  targetOrigin?: string;
  /**
   * Glob over `ToolAction.argumentSummary`: `*` matches any run of characters, everything else is
   * literal. Absent matches any arguments.
   */
  argumentPattern?: string;
  sqlStatementKind?: ToolAction["sqlStatementKind"];
  /** Rule applies when `action.amount` is at or below this value. */
  maxAmount?: number;
  /** Exact path or a directory prefix ending in `/`. */
  filePath?: string;
  /** Exact `ToolAction.inputSha256`: the same input, and only it (A6). */
  inputSha256?: string;
  originatingBotId?: BotId;
}

export interface ApprovalRule {
  id: string;
  botId: BotId;
  matcher: ApprovalRuleMatcher;
  decision: Exclude<ApprovalDecision, "allow_once">;
  createdFromApprovalId?: ApprovalId;
  /** `human:<authorId>` or `bot:<botId>`, as for `Approval.decidedBy`. */
  createdBy: string;
  createdAt: IsoTimestamp;
}

/** Glob with `*` as the only wildcard; the rest of the pattern is literal. Case-sensitive. */
export function globMatches(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i === 0) {
      if (!value.startsWith(part)) return false;
      pos = part.length;
      continue;
    }
    if (i === parts.length - 1)
      return part === "" || (value.endsWith(part) && value.length - part.length >= pos);
    const found = value.indexOf(part, pos);
    if (found < 0) return false;
    pos = found + part.length;
  }
  return true;
}

/**
 * Whether a stored rule answers an action. Rules are per bot; the tier check has already run
 * (only L2 actions reach rule matching), so a rule can never widen L0/L1 handling.
 */
export function approvalRuleMatches(rule: ApprovalRule, action: ToolAction, botId: BotId): boolean {
  if (rule.botId !== botId) return false;
  const m = rule.matcher;
  // ADR-0045 decision 4: a credential release is allowed by a rule only when the rule binds that
  // tool, the entry's exact origin and the exact `vault:<id> rev:<n> op:<operation>` dimension. A
  // broad tool-name or origin glob never authorizes one; a deny rule still matches as written.
  if (rule.decision !== "deny" && isVaultUseTool(action.toolName) && !vaultRuleExact(m, action))
    return false;
  if (m.toolName !== undefined && m.toolName !== action.toolName) return false;
  if (m.originatingBotId !== undefined && m.originatingBotId !== botId) return false;
  if (m.targetOrigin !== undefined) {
    if (action.targetOrigin === undefined || !globMatches(m.targetOrigin, action.targetOrigin)) {
      return false;
    }
  }
  if (m.argumentPattern !== undefined) {
    if (
      action.argumentSummary === undefined ||
      !globMatches(m.argumentPattern, action.argumentSummary)
    ) {
      return false;
    }
  }
  if (m.sqlStatementKind !== undefined && m.sqlStatementKind !== action.sqlStatementKind) {
    return false;
  }
  if (m.maxAmount !== undefined && (action.amount === undefined || action.amount > m.maxAmount)) {
    return false;
  }
  if (m.filePath !== undefined) {
    if (action.filePath === undefined) return false;
    const dir = m.filePath.endsWith("/");
    if (dir ? !action.filePath.startsWith(m.filePath) : action.filePath !== m.filePath)
      return false;
  }
  if (m.inputSha256 !== undefined && m.inputSha256 !== action.inputSha256) return false;
  return true;
}

/** Whether a matcher binds a credential release exactly (ADR-0045 decision 4). */
function vaultRuleExact(m: ApprovalRuleMatcher, action: ToolAction): boolean {
  return (
    m.toolName === action.toolName &&
    action.targetOrigin !== undefined &&
    m.targetOrigin === action.targetOrigin &&
    !m.targetOrigin.includes("*") &&
    action.argumentPattern !== undefined &&
    m.argumentPattern === action.argumentPattern &&
    !m.argumentPattern.includes("*") &&
    action.argumentSummary === action.argumentPattern
  );
}

/** The character the sidecar ends a shortened `argumentSummary` with. */
export const ARGUMENT_TRUNCATION_MARKER = "…";

/**
 * The directory prefix a file tool's Always rule stores: everything up to and including the last
 * `/` of the path, so a later write to another file in the same directory matches. A path with
 * no directory part stays exact.
 */
export function filePathPrefix(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? filePath : filePath.slice(0, slash + 1);
}

/**
 * The matcher an "Always" decision proposes: the tool plus a stable target, never the displayed
 * argument summary (ADR-0002 amendment 3, A6). By tool kind:
 *
 * - The sidecar's stable `argumentPattern` when it derived one: the program and subcommand of a
 *   shell line, the side-effect phrase of a click (`*submit*`), the subagent type of a spawn
 *   (`agent Explore: *`), a hash for exact code or terminal input, the connector or integration
 *   action. The origin the call was made against is kept beside it.
 * - Otherwise a file tool's directory prefix (`filePathPrefix`).
 * - Otherwise the origin, for browser and HTTP tools.
 * - Otherwise the input's hash (`inputSha256`): this exact input again, nothing else.
 *
 * Undefined when the action offers none of these (an action recorded before A6 with only a
 * summary): Always then needs a matcher the human writes. Rules stored before A6 are matched as
 * they always were; only new rules are built here.
 */
export function matcherFromAction(action: ToolAction): ApprovalRuleMatcher | undefined {
  const m: ApprovalRuleMatcher = { toolName: action.toolName };
  if (action.argumentPattern !== undefined) {
    if (action.targetOrigin !== undefined) m.targetOrigin = action.targetOrigin;
    m.argumentPattern = action.argumentPattern;
    return m;
  }
  if (action.filePath !== undefined) {
    m.filePath = filePathPrefix(action.filePath);
    return m;
  }
  if (action.targetOrigin !== undefined) {
    m.targetOrigin = action.targetOrigin;
    return m;
  }
  if (action.inputSha256 !== undefined) {
    m.inputSha256 = action.inputSha256;
    return m;
  }
  return undefined;
}

/** Why the Gateway refuses to store an Always rule (A6); the `reason` of its `validation` error. */
export type ApprovalRuleRefusal =
  /** No stable target could be derived and no matcher was given. */
  | "rule_no_stable_target"
  /** `argumentPattern` ends in the summary's truncation marker, so it can never match again. */
  | "rule_pattern_truncated"
  /** The matcher does not match the action the Always decision answers. */
  | "rule_does_not_match_action"
  /**
   * A credential release's rule must bind its exact entry, revision, operation and origin
   * (ADR-0045 decision 4); a widened scope is refused.
   */
  | "rule_vault_not_exact";

/**
 * Why a stored rule is accepted but flagged (A6). `exact_arguments`: an `argumentPattern` with no
 * `*` that is not the sidecar's own stable pattern for the answered action, so the rule matches
 * only this wording again. `exact_input`: the rule is bound to one input's hash.
 */
export type ApprovalRuleWarning = "exact_arguments" | "exact_input";

export type AlwaysRuleCheck =
  | { ok: true; warnings: ApprovalRuleWarning[] }
  | { ok: false; refusal: ApprovalRuleRefusal; message: string };

/**
 * The checks the Gateway runs before it stores a rule (A6), shared with the web card so a human
 * sees the refusal or the warning before saving. `answers` is the action an Always decision
 * answers; a rule typed in outside any approval has none and is checked for truncation only.
 */
export function checkAlwaysRule(
  matcher: ApprovalRuleMatcher,
  answers?: { action: ToolAction; botId: BotId },
): AlwaysRuleCheck {
  const pattern = matcher.argumentPattern;
  if (pattern?.endsWith(ARGUMENT_TRUNCATION_MARKER)) {
    return {
      ok: false,
      refusal: "rule_pattern_truncated",
      message:
        "the argument pattern ends in the truncation marker of a shortened summary, so it would never match again; end it with * instead",
    };
  }
  if (
    answers !== undefined &&
    isVaultUseTool(answers.action.toolName) &&
    !vaultRuleExact(matcher, answers.action)
  ) {
    return {
      ok: false,
      refusal: "rule_vault_not_exact",
      message:
        "a credential release can be allowed again only for the same entry, revision, operation and exact origin",
    };
  }
  if (answers !== undefined) {
    const probe: ApprovalRule = {
      id: "",
      botId: answers.botId,
      matcher,
      decision: "allow_always",
      createdBy: "",
      createdAt: "",
    };
    if (!approvalRuleMatches(probe, answers.action, answers.botId)) {
      return {
        ok: false,
        refusal: "rule_does_not_match_action",
        message: "the rule does not match the action it answers",
      };
    }
  }
  const warnings: ApprovalRuleWarning[] = [];
  if (
    pattern !== undefined &&
    !pattern.includes("*") &&
    pattern !== answers?.action.argumentPattern
  ) {
    warnings.push("exact_arguments");
  }
  if (matcher.inputSha256 !== undefined) warnings.push("exact_input");
  return { ok: true, warnings };
}

/**
 * An operator's override of one tool's tier in one workspace (ADR-0002 amendment 3, A5). It is an
 * operator action recorded with `createdBy` (`human:<id>`), never a bot action. No override is
 * the default. It changes only the tier table's answer: the hard denies (egress, private
 * addresses, IP literals, metadata, cross-workspace refusals, the directory guard, the secret
 * scrub) run before the tier and are never overridden.
 */
export interface ToolTierOverride {
  toolName: string;
  riskLevel: RiskLevel;
  createdBy: string;
  createdAt: IsoTimestamp;
}

/**
 * Tools whose tier is not the table's to give, so no override applies: a connector submit is
 * tiered by its stored validation's effect class (ADR-0012), an integration action by the
 * catalog's operation type and its own operator override (ADR-0013).
 */
export const TOOL_TIER_OVERRIDE_EXCLUDED: readonly string[] = [
  "mcp__deskmates__connector_submit",
  "mcp__deskmates__integration_execute",
  // ADR-0045 decision 4: a credential release is L2 under every override.
  "mcp__deskmates__vault_fill",
  "mcp__deskmates__vault_request",
];

/** A tool name an override may name: the full name the SDK reports, `mcp__<server>__<tool>`. */
export const TOOL_TIER_OVERRIDE_NAME = /^[A-Za-z0-9_.-]{1,200}$/;

export function isRiskLevel(value: unknown): value is RiskLevel {
  return value === "L0" || value === "L1" || value === "L2";
}

/** The first rule that answers the action, in the order given (the store lists oldest first). */
export function findMatchingRule(
  rules: readonly ApprovalRule[],
  action: ToolAction,
  botId: BotId,
): ApprovalRule | undefined {
  return rules.find((r) => approvalRuleMatches(r, action, botId));
}
