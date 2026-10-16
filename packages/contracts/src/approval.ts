// Risk tiers and approvals (design v0.3 §3.5, ADR-0002 decision 2).

import type { ApprovalId, BotId, IsoTimestamp, MessageId, RunId, ThreadId } from "./ids.js";

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
  return true;
}

/**
 * The matcher an "Always" decision stores: tool name, the origin the call was made against, and
 * the sidecar's stable `argumentPattern` (or the summary verbatim when it gave none).
 */
export function matcherFromAction(action: ToolAction): ApprovalRuleMatcher {
  const m: ApprovalRuleMatcher = { toolName: action.toolName };
  if (action.targetOrigin !== undefined) m.targetOrigin = action.targetOrigin;
  const pattern = action.argumentPattern ?? action.argumentSummary;
  if (pattern !== undefined) m.argumentPattern = pattern;
  return m;
}

/** The first rule that answers the action, in the order given (the store lists oldest first). */
export function findMatchingRule(
  rules: readonly ApprovalRule[],
  action: ToolAction,
  botId: BotId,
): ApprovalRule | undefined {
  return rules.find((r) => approvalRuleMatches(r, action, botId));
}
