// Small body validators for the M0 routes. They throw `validation` DeskmatesErrors; nothing here
// knows about HTTP.

import {
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalRuleMatcher,
  type Attachment,
  type BotId,
  type CronEntry,
  DeskmatesError,
  type DoNotLearnReason,
  EFFORT_LEVELS,
  type EffortLevel,
  type LearnedItem,
  MEMORY_AUTHORITIES,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  type MemoryAuthority,
  type MemoryScope,
  type MemorySourceKind,
  type ProposedSkill,
  type RiskLevel,
  type RunEnded,
  type RunId,
  type RunSummary,
  type RunTaint,
  type RunUsage,
  type ThinkingConfig,
  type ToolAction,
  isEffortLevel,
  isThinkingConfig,
  parseCron,
} from "@deskmates/contracts";

export function asRecord(body: unknown, what = "body"): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DeskmatesError("validation", `${what} must be a JSON object`);
  }
  return body as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new DeskmatesError("validation", `${key} is required`, { key });
  }
  return v;
}

export function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string")
    throw new DeskmatesError("validation", `${key} must be a string`, { key });
  return v;
}

export function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean")
    throw new DeskmatesError("validation", `${key} must be a boolean`, { key });
  return v;
}

/** A reasoning effort level, or `null` to clear; undefined when the key is absent. */
export function optionalEffort(
  obj: Record<string, unknown>,
  key = "effort",
): EffortLevel | null | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isEffortLevel(v)) {
    throw new DeskmatesError("validation", `${key} must be one of ${EFFORT_LEVELS.join(", ")}`, {
      key,
    });
  }
  return v;
}

/** A thinking configuration (`{type: adaptive|enabled|disabled}`), or `null` to clear. */
export function optionalThinking(
  obj: Record<string, unknown>,
  key = "thinking",
): ThinkingConfig | null | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isThinkingConfig(v)) {
    throw new DeskmatesError(
      "validation",
      `${key} must be {type: "adaptive"}, {type: "enabled", budgetTokens?} or {type: "disabled"}`,
      { key },
    );
  }
  return v;
}

export function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new DeskmatesError("validation", `${key} must be an array of strings`, { key });
  }
  return v as string[];
}

export function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = optionalStringArray(obj, key);
  if (!v || v.length === 0) throw new DeskmatesError("validation", `${key} is required`, { key });
  return v;
}

/** A field that must be a string; unlike `requireString` the empty string is allowed. */
function plainString(obj: Record<string, unknown>, key: string, what: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new DeskmatesError("validation", `${what} ${key} must be a string`, {
      key,
      got: typeof v,
    });
  }
  return v;
}

/**
 * `thread_post` attachments. The sidecar is not trusted to send the right shape: anything that is
 * not `{name, mimeType, ref}` strings would otherwise land in `thread_messages.attachments_json`
 * and come back out of the API as a `ThreadMessage` the contracts type says cannot exist.
 */
export function asAttachments(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new DeskmatesError("validation", "attachments must be an array");
  }
  return raw.map((item) => {
    const a = asRecord(item, "attachment");
    return {
      name: plainString(a, "name", "attachment"),
      mimeType: plainString(a, "mimeType", "attachment"),
      ref: plainString(a, "ref", "attachment"),
    };
  });
}

/**
 * A bot's cron entries. Every schedule is parsed here, at the edge: an expression the cron runner
 * cannot read would otherwise sit in `bots.cron_json` and fail silently once a minute, forever.
 */
export function asCronEntries(raw: unknown): CronEntry[] {
  if (!Array.isArray(raw)) {
    throw new DeskmatesError("validation", "cron must be an array of {schedule, prompt}");
  }
  return raw.map((item) => {
    const entry = asRecord(item, "cron entry");
    const schedule = requireString(entry, "schedule");
    parseCron(schedule);
    return { schedule, prompt: requireString(entry, "prompt") };
  });
}

const USAGE_COUNT_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreateTokens",
] as const;

/**
 * `RunEnded.usage`. Every field goes straight into a `run_usage` column, so a wrong type is a
 * NOT NULL / datatype failure halfway through the end-of-run write rather than a client error.
 */
export function asUsageList(raw: unknown): Omit<RunUsage, "runId" | "costUsd">[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new DeskmatesError("validation", "usage must be an array");
  }
  return raw.map((item) => {
    const u = asRecord(item, "usage entry");
    const model = u.model;
    if (typeof model !== "string" || model.trim() === "") {
      throw new DeskmatesError("validation", "each usage entry needs a non-empty string model", {
        got: model,
      });
    }
    const counts: Record<string, number> = {};
    for (const key of USAGE_COUNT_KEYS) {
      const n = u[key];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
        throw new DeskmatesError("validation", `usage ${key} must be a non-negative safe integer`, {
          model,
          key,
          got: n,
        });
      }
      counts[key] = n;
    }
    return {
      model,
      inputTokens: counts.inputTokens as number,
      outputTokens: counts.outputTokens as number,
      cacheReadTokens: counts.cacheReadTokens as number,
      cacheCreateTokens: counts.cacheCreateTokens as number,
    };
  });
}

/**
 * `RunEnded.summary`. `reply` decides whether the run ends `succeeded` or `silent` and is posted
 * as the bot's message, so it must be a string before any row is written; the four list fields
 * default to empty when absent but a wrong type is a client error, not a stored surprise.
 */
export function asRunSummary(raw: unknown): RunSummary {
  const s = asRecord(raw, "summary");
  return {
    done: plainString(s, "done", "summary"),
    reply: plainString(s, "reply", "summary"),
    filesChanged: optionalStringArray(s, "filesChanged") ?? [],
    sitesVisited: optionalStringArray(s, "sitesVisited") ?? [],
    pendingApprovals: optionalStringArray(s, "pendingApprovals") ?? [],
    memorySuggestions: optionalStringArray(s, "memorySuggestions") ?? [],
    learned: learnedItems(s.learned),
    ...(Array.isArray(s.skills) ? { skills: proposedSkills(s.skills) } : {}),
  };
}

/** Longest instruction text a proposed skill may carry; the store caps the whole skill too. */
const PROPOSED_SKILL_MAX_CHARS = 64 * 1024;

/**
 * `RunSummary.skills` (ADR-0015 decision 2). Like `learned`, a malformed item is dropped, never
 * an error. Whether a well-formed one is stored is the Gateway's decision, not the summary's.
 */
function proposedSkills(raw: readonly unknown[]): ProposedSkill[] {
  const out: ProposedSkill[] = [];
  for (const value of raw.slice(0, 5)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.description !== "string") continue;
    if (typeof r.body !== "string" || r.body.trim() === "") continue;
    if (r.body.length + r.description.length > PROPOSED_SKILL_MAX_CHARS) continue;
    out.push({ name: r.name, description: r.description, body: r.body });
  }
  return out;
}

const LEARNED_SCOPES: ReadonlySet<string> = new Set<MemoryScope>(MEMORY_SCOPES);
const LEARNED_AUTHORITIES: ReadonlySet<string> = new Set<MemoryAuthority>(MEMORY_AUTHORITIES);
const LEARNED_SOURCES: ReadonlySet<string> = new Set<MemorySourceKind>(MEMORY_SOURCE_KINDS);
const DO_NOT_LEARN_REASONS: ReadonlySet<string> = new Set<DoNotLearnReason>([
  "egress_block",
  "browser_wait",
  "approval_deferred",
  "approval_denied",
  "approval_timeout",
  "model_proxy_error",
  "transport_error",
  "sandbox_error",
  "failed_run",
  "negative_capability_claim",
  "session_state",
]);

/**
 * `RunSummary.learned` (ADR-0011). A malformed item is dropped, never an error: it must not turn a
 * finished run into a failed one. `trust` is kept only as the literal `trusted`; anything else is
 * untrusted by omission, which is what the learned-write path assumes of a missing value.
 */
function learnedItems(raw: unknown): LearnedItem[] {
  if (!Array.isArray(raw)) return [];
  const items: LearnedItem[] = [];
  for (const value of raw.slice(0, 50)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (typeof r.body !== "string" || r.body.trim() === "") continue;
    if (typeof r.proposedScope !== "string" || !LEARNED_SCOPES.has(r.proposedScope)) continue;
    const authority =
      typeof r.authority === "string" && LEARNED_AUTHORITIES.has(r.authority)
        ? (r.authority as MemoryAuthority)
        : "fact";
    items.push({
      body: r.body,
      proposedScope: r.proposedScope as MemoryScope,
      authority,
      turn: typeof r.turn === "number" && Number.isFinite(r.turn) ? r.turn : 0,
      ...(r.trust === "trusted" ? { trust: "trusted" as const } : { trust: "untrusted" as const }),
      ...(typeof r.sourceKind === "string" && LEARNED_SOURCES.has(r.sourceKind)
        ? { sourceKind: r.sourceKind as MemorySourceKind }
        : {}),
      ...(Array.isArray(r.doNotLearnReasons) &&
      r.doNotLearnReasons.every(
        (reason) => typeof reason === "string" && DO_NOT_LEARN_REASONS.has(reason),
      )
        ? { doNotLearnReasons: r.doNotLearnReasons as DoNotLearnReason[] }
        : {}),
      // ADR-0011 A9: the sidecar's turn time; the learned-write path clamps it to the run.
      ...(typeof r.observedAt === "string" && !Number.isNaN(Date.parse(r.observedAt))
        ? { observedAt: r.observedAt }
        : {}),
    });
  }
  return items;
}

/** `RunEnded.taint`; dropped when malformed. */
function runTaint(raw: unknown): RunTaint | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.turns !== "number" || !Number.isSafeInteger(r.turns) || r.turns < 0)
    return undefined;
  return {
    turns: r.turns,
    ...(typeof r.taintedAtTurn === "number" && Number.isSafeInteger(r.taintedAtTurn)
      ? { taintedAtTurn: r.taintedAtTurn }
      : {}),
    ...(typeof r.sourceKind === "string" && LEARNED_SOURCES.has(r.sourceKind)
      ? { sourceKind: r.sourceKind as MemorySourceKind }
      : {}),
    ...(Array.isArray(r.doNotLearnReasons) &&
    r.doNotLearnReasons.every(
      (value) => typeof value === "string" && DO_NOT_LEARN_REASONS.has(value),
    )
      ? { doNotLearnReasons: r.doNotLearnReasons as NonNullable<RunTaint["doNotLearnReasons"]> }
      : {}),
  };
}

/**
 * A complete `RunEnded` from an untrusted body: the internal route's `POST .../ended`, and the
 * `RUN_ENDED <json>` line a sidecar prints when it could not deliver that post. Everything is
 * checked before anything is written.
 */
export function asRunEnded(runId: RunId, raw: unknown): RunEnded {
  const body = asRecord(raw, "run_ended") as Partial<RunEnded>;
  if (
    body.type !== "run_ended" ||
    (body.outcome !== "completed" &&
      body.outcome !== "deferred" &&
      body.outcome !== "failed" &&
      body.outcome !== "turns_exhausted")
  ) {
    throw new DeskmatesError("validation", "expected a RunEnded with an outcome");
  }
  const ended: RunEnded = {
    type: "run_ended",
    runId,
    outcome: body.outcome,
    usage: asUsageList(body.usage),
  };
  if (typeof body.sdkSessionId === "string") ended.sdkSessionId = body.sdkSessionId;
  if (
    typeof body.handoffPath === "string" &&
    /^\/work\/[A-Za-z0-9._\-/]+$/.test(body.handoffPath) &&
    !body.handoffPath.split("/").includes("..")
  )
    ended.handoffPath = body.handoffPath;
  if (body.summary !== undefined && body.summary !== null) {
    ended.summary = asRunSummary(body.summary);
  }
  if (typeof body.error === "string") ended.error = body.error;
  if (typeof body.pendingApprovalId === "string") {
    ended.pendingApprovalId = body.pendingApprovalId as ApprovalId;
  }
  if (typeof body.pendingToolUseId === "string") ended.pendingToolUseId = body.pendingToolUseId;
  // The origin the parked process was on; the resume hands it to the new one so its first browser
  // call has a `targetOrigin` before it navigates (ADR-0002 amendment 2, "2, stale snapshot").
  if (typeof body.currentOrigin === "string") ended.currentOrigin = body.currentOrigin;
  // Context observability (M3 context plan, Phase 1). A malformed value is dropped, not an
  // error: it must never turn a finished run into a failed one.
  if (
    typeof body.systemPromptSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(body.systemPromptSha256)
  ) {
    ended.systemPromptSha256 = body.systemPromptSha256;
  }
  if (
    typeof body.systemPromptStaticSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(body.systemPromptStaticSha256)
  ) {
    ended.systemPromptStaticSha256 = body.systemPromptStaticSha256;
  }
  if (
    typeof body.maxContextTokens === "number" &&
    Number.isSafeInteger(body.maxContextTokens) &&
    body.maxContextTokens > 0
  ) {
    ended.maxContextTokens = body.maxContextTokens;
  }
  const taint = runTaint(body.taint);
  if (taint) ended.taint = taint;
  return ended;
}

const RISK_LEVELS: ReadonlySet<string> = new Set<RiskLevel>(["L0", "L1", "L2"]);
const SQL_KINDS: ReadonlySet<string> = new Set<NonNullable<ToolAction["sqlStatementKind"]>>([
  "select",
  "insert",
  "update",
  "delete",
  "ddl",
  "other",
]);
const APPROVAL_DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>([
  "allow_once",
  "allow_always",
  "deny",
]);

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new DeskmatesError("validation", `${key} must be a finite number`, { key, got: v });
  }
  return v;
}

function asSqlStatementKind(value: unknown): NonNullable<ToolAction["sqlStatementKind"]> {
  if (typeof value !== "string" || !SQL_KINDS.has(value)) {
    throw new DeskmatesError("validation", "sqlStatementKind is not a known kind", { got: value });
  }
  return value as NonNullable<ToolAction["sqlStatementKind"]>;
}

/**
 * The `ToolAction` the hook judged. The Gateway stores it, matches rules against it and puts
 * parts of it in a thread message, so every field is checked before any of that happens.
 */
export function asToolAction(raw: unknown): ToolAction {
  const a = asRecord(raw, "action");
  const toolName = a.toolName;
  if (typeof toolName !== "string" || toolName.trim() === "") {
    throw new DeskmatesError("validation", "action needs a non-empty string toolName", {
      got: toolName,
    });
  }
  const action: ToolAction = { toolName, input: asRecord(a.input ?? {}, "action input") };
  const targetOrigin = optionalString(a, "targetOrigin");
  if (targetOrigin !== undefined) action.targetOrigin = targetOrigin;
  const argumentSummary = optionalString(a, "argumentSummary");
  if (argumentSummary !== undefined) action.argumentSummary = argumentSummary;
  const argumentPattern = optionalString(a, "argumentPattern");
  if (argumentPattern !== undefined) action.argumentPattern = argumentPattern;
  const filePath = optionalString(a, "filePath");
  if (filePath !== undefined) action.filePath = filePath;
  const amount = optionalNumber(a, "amount");
  if (amount !== undefined) action.amount = amount;
  if (a.sqlStatementKind !== undefined && a.sqlStatementKind !== null) {
    action.sqlStatementKind = asSqlStatementKind(a.sqlStatementKind);
  }
  // Display-only labels from the sidecar's hook (ADR-0002 amendment 3, A5).
  const agentType = optionalString(a, "agentType");
  if (agentType !== undefined) action.agentType = agentType;
  if (a.unclassified !== undefined && a.unclassified !== null) {
    if (a.unclassified !== true) {
      throw new DeskmatesError("validation", "unclassified must be true when present", {
        got: a.unclassified,
      });
    }
    action.unclassified = true;
  }
  return action;
}

/** `POST /internal/runs/:runId/approvals`, from the sidecar's PreToolUse hook. */
export function asApprovalRequest(runId: RunId, raw: unknown): ApprovalRequest {
  const body = asRecord(raw, "approval_request") as Partial<ApprovalRequest>;
  if (body.type !== "approval_request") {
    throw new DeskmatesError("validation", "expected an ApprovalRequest");
  }
  if (typeof body.approvalId !== "string" || body.approvalId.trim() === "") {
    throw new DeskmatesError("validation", "approvalId is required", { got: body.approvalId });
  }
  if (typeof body.riskLevel !== "string" || !RISK_LEVELS.has(body.riskLevel)) {
    throw new DeskmatesError("validation", "riskLevel must be L0, L1 or L2", {
      got: body.riskLevel,
    });
  }
  const req: ApprovalRequest = {
    type: "approval_request",
    runId,
    approvalId: body.approvalId as ApprovalId,
    action: asToolAction(body.action),
    riskLevel: body.riskLevel as RiskLevel,
  };
  if (typeof body.toolUseId === "string") req.toolUseId = body.toolUseId;
  // ADR-0020: an egress ask is the only other kind; anything else is a tool call.
  if (body.kind === "egress") req.kind = "egress";
  return req;
}

/** One of the three decisions, from either decide route. */
export function asApprovalDecision(value: unknown): ApprovalDecision {
  if (typeof value !== "string" || !APPROVAL_DECISIONS.has(value)) {
    throw new DeskmatesError("validation", "decision must be allow_once, allow_always or deny", {
      got: value,
    });
  }
  return value as ApprovalDecision;
}

/** An operator-authored rule matcher. Every field is optional; a wrong type is a client error. */
export function asRuleMatcher(raw: unknown): ApprovalRuleMatcher {
  const m = asRecord(raw, "matcher");
  const matcher: ApprovalRuleMatcher = {};
  const toolName = optionalString(m, "toolName");
  if (toolName !== undefined) matcher.toolName = toolName;
  const targetOrigin = optionalString(m, "targetOrigin");
  if (targetOrigin !== undefined) matcher.targetOrigin = targetOrigin;
  const argumentPattern = optionalString(m, "argumentPattern");
  if (argumentPattern !== undefined) matcher.argumentPattern = argumentPattern;
  const filePath = optionalString(m, "filePath");
  if (filePath !== undefined) matcher.filePath = filePath;
  const originatingBotId = optionalString(m, "originatingBotId");
  if (originatingBotId !== undefined) matcher.originatingBotId = originatingBotId as BotId;
  const maxAmount = optionalNumber(m, "maxAmount");
  if (maxAmount !== undefined) matcher.maxAmount = maxAmount;
  if (m.sqlStatementKind !== undefined && m.sqlStatementKind !== null) {
    matcher.sqlStatementKind = asSqlStatementKind(m.sqlStatementKind);
  }
  return matcher;
}
