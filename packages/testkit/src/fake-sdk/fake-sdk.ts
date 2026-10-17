// Scripted stand-in for `query()` from `@anthropic-ai/claude-agent-sdk`.
//
// It plays a script (assistant text, thinking, tool calls, end) and emits messages with the same
// shapes as the real SDK. At every tool call it runs `options.hooks.PreToolUse` and then
// `options.canUseTool` at the same points the real SDK does, honouring `allow`, `deny`, `defer`,
// `resume` and `AbortSignal`. The behaviours were observed in S0 (`spikes/s0/test-a`, `test-b`):
//
//   - hook returns `allow`            -> the tool runs, a `user` message carries the tool_result
//   - hook throws or runs past the matcher's `timeout` (seconds) -> no decision from that hook,
//                                        as in the real CLI: the call falls through to the next
//                                        hook and then to `canUseTool`
//   - hook returns `deny`             -> `permissionDecisionReason` becomes the (error) tool_result
//   - hook returns `defer`            -> the query ends at once with a `result` carrying
//                                        `session_id` (+ `deferred_tool_use`); the process may exit
//   - later `query({ resume })`       -> the deferred call goes through the hook again first
//   - hook returns nothing or `ask`   -> `canUseTool(toolName, input, { signal, ... })` decides;
//                                        the fake does not advance until it resolves
//   - `abortController.signal` fires  -> the generator throws an `AbortError`
//   - the `result` message carries `usage`, `modelUsage` and `num_turns`
//   - every assistant message carries `message.usage`, the step's own `usage` when it has one
//   - a `compact` step runs `options.hooks.PreCompact`, then emits `system` / `compact_boundary`
//   - a `model_switch` step runs `options.hooks.PostModelSwitch`, then later assistant messages
//     carry the new model and `modelUsage` reports usage per model (default target: the first
//     entry of `options.fallbackModel`, as on an overloaded primary)
//   - a `model_fallback` step emits `system` / `model_fallback` without the hook, as SDK 0.3.278
//     does on an overloaded primary, then the fallback serves as after a `model_switch`
//   - an `api_retry` step emits `system` / `api_retry`; a `fail` step ends the session with an
//     `error_during_execution` result
//
// Tools whose name is `mcp__<server>__<tool>` where `<server>` is an in-process server created by
// this fake's `createSdkMcpServer` are executed by calling the registered handler, as the real
// SDK does; every other tool returns the script step's `result`.
//
// `tools` selects built-ins and `disallowedTools` removes tools from the model's list.
// Unavailable calls reach neither hooks nor `canUseTool`. `allowedTools` supplies permission
// defaults after hooks; it does not select the available tools.

import { randomUUID } from "node:crypto";
import type { ScriptSource, ScriptStep, ScriptUsage } from "./script.js";
import type {
  SdkApiRetryMessage,
  SdkApiUsage,
  SdkAssistantMessage,
  SdkCallToolResult,
  SdkCompactBoundaryMessage,
  SdkContentBlock,
  SdkContextUsageResponse,
  SdkHookMatcher,
  SdkHookOutput,
  SdkHookPermissionDecision,
  SdkInferShape,
  SdkMcpServerConfigWithInstance,
  SdkMcpServerOptions,
  SdkMessage,
  SdkModelFallbackMessage,
  SdkModelUsage,
  SdkPostModelSwitchHookInput,
  SdkPreCompactHookInput,
  SdkPreToolUseHookInput,
  SdkQueryOptions,
  SdkQueryParams,
  SdkResultErrorMessage,
  SdkResultSuccessMessage,
  SdkSessionStartHookInput,
  SdkSystemInitMessage,
  SdkToolDefinition,
  SdkToolDefinitionLoose,
  SdkUserMessage,
  SdkUuid,
} from "./sdk-shapes.js";

export interface FakeToolCallRecord {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** What the PreToolUse hooks decided; `none` when no hook returned a decision. */
  hookDecision: SdkHookPermissionDecision | "none";
  hookReason?: string;
  /** Message of the last hook that threw; a throw leaves no decision, as in the real CLI. */
  hookError?: string;
  /** Set when a hook ran past its matcher's `timeout`; it leaves no decision either. */
  hookTimedOut?: boolean;
  /**
   * Set when `disallowedTools` / `tools` kept the tool out of the model's list. Neither the
   * hook nor `canUseTool` ran; `executed` is false and `result` is the "not available" error.
   */
  unavailable?: boolean;
  /** Present only when `canUseTool` was consulted. */
  callbackDecision?: "allow" | "deny";
  executed: boolean;
  result: string;
}

export interface FakeDeferredCall {
  stepIndex: number;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface FakeSession {
  id: string;
  script: readonly ScriptStep[];
  /** Index of the next step to play. */
  cursor: number;
  /** Set when the hook returned `defer`; replayed through the hook by the next `query({ resume })`. */
  deferred: FakeDeferredCall | undefined;
  /** Every `query()` call that touched this session, in order. */
  calls: SdkQueryParams[];
  toolCalls: FakeToolCallRecord[];
  /** Every message emitted for this session, across calls. */
  messages: SdkMessage[];
}

export interface FakeSdkConfig {
  /**
   * Tools the real SDK never prompts for. When the hook returns no decision for one of these the
   * fake executes it without consulting `canUseTool`, like the real SDK.
   */
  readOnlyTools?: readonly string[];
  /** Reported as `claude_code_version` on the init message. */
  version?: string;
  /**
   * What `getContextUsage` answers; the default is a small fixed breakdown. A throw is passed on
   * to the caller, like a CLI that cannot answer the control request.
   */
  contextUsage?: (detail: "summary" | "full") => SdkContextUsageResponse;
  /** The resume fields of the `SessionStart` hook input when a known session is resumed. */
  resumeFacts?: Pick<
    SdkSessionStartHookInput,
    "seconds_since_last_response" | "context_tokens" | "prompt_cache_likely_expired"
  >;
}

/** What `query()` returns: the message stream plus the control method the sidecar calls. */
export type FakeQuery = AsyncGenerator<SdkMessage, void, undefined> & {
  getContextUsage(opts?: { detail?: "summary" | "full" }): Promise<SdkContextUsageResponse>;
};

/** A small, fixed `getContextUsage` answer. */
export function defaultContextUsage(model: string): SdkContextUsageResponse {
  return {
    categories: [
      { name: "System prompt", tokens: 3000, color: "", kind: "used" },
      { name: "System tools", tokens: 12000, color: "", kind: "used" },
      { name: "MCP tools", tokens: 6000, color: "", kind: "used" },
      { name: "Messages", tokens: 500, color: "", kind: "used" },
      { name: "Free space", tokens: 178500, color: "", kind: "free" },
    ],
    totalTokens: 21500,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 11,
    model,
    memoryFiles: [],
    mcpTools: [
      { name: "mcp__browser__browser_navigate", serverName: "browser", tokens: 4000 },
      { name: "mcp__deskmates__thread_post", serverName: "deskmates", tokens: 2000 },
    ],
    systemTools: [
      { name: "Bash", tokens: 9000 },
      { name: "Read", tokens: 3000 },
    ],
  };
}

export interface FakeSdk {
  query: (params: SdkQueryParams) => FakeQuery;
  /** Every `getContextUsage` call, in order, across queries. */
  contextUsageCalls: { detail: "summary" | "full" }[];
  tool: <Schema, Result = SdkCallToolResult>(
    name: string,
    description: string,
    inputSchema: Schema,
    handler: (args: SdkInferShape<Schema>, extra: unknown) => Promise<Result>,
  ) => SdkToolDefinition<Schema, Result>;
  createSdkMcpServer: (options: SdkMcpServerOptions) => SdkMcpServerConfigWithInstance;
  /** Session state, keyed by session id, for assertions. */
  sessions: Map<string, FakeSession>;
}

const DEFAULT_READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "LS", "TodoRead"] as const;

const DEFAULT_TURN_USAGE: ScriptUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
};

interface InProcessServer {
  name: string;
  tools: Map<string, SdkToolDefinitionLoose>;
}

/** What a `tool_call` step says the tool returns: its text and whether that text is a failure. */
interface ScriptedResult {
  result: string | undefined;
  isError: boolean | undefined;
  /** Set when the call is made inside a subagent: the hook input carries `agent_id`/`agent_type`. */
  subagent?: { agentId: string; agentType: string } | undefined;
}

type PipelineOutcome =
  | { kind: "executed"; text: string; isError: boolean }
  | { kind: "denied"; text: string }
  | { kind: "unavailable"; text: string }
  | { kind: "defer" };

/** Sentinel for a hook that ran past its matcher's `timeout`. */
const HOOK_TIMED_OUT: unique symbol = Symbol("hook-timed-out");

function uuid(): SdkUuid {
  return randomUUID();
}

function abortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Resolve with `promise`, or reject with AbortError as soon as `signal` fires. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError"
  );
}

/** Resolve with `promise`, or with HOOK_TIMED_OUT once `seconds` have passed. */
function withHookTimeout<T>(
  promise: Promise<T>,
  seconds: number | undefined,
): Promise<T | typeof HOOK_TIMED_OUT> {
  if (seconds === undefined) return promise;
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<typeof HOOK_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(HOOK_TIMED_OUT), seconds * 1000);
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Whether the model was offered this tool at all. The real SDK drops a tool named in
 * `disallowedTools`; an explicit `tools` list selects built-ins without removing MCP tools.
 */
function toolIsAvailable(options: SdkQueryOptions, name: string): boolean {
  if (options.disallowedTools?.includes(name)) return false;
  if (Array.isArray(options.tools) && !name.startsWith("mcp__") && !options.tools.includes(name)) {
    return false;
  }
  return true;
}

/** The tool list reported on `system.init`: what the script would use, minus what was dropped. */
function offeredTools(options: SdkQueryOptions, script: readonly ScriptStep[]): string[] {
  const names: string[] = [];
  for (const step of script) {
    if (step.type !== "tool_call") continue;
    if (names.includes(step.name)) continue;
    if (!toolIsAvailable(options, step.name)) continue;
    names.push(step.name);
  }
  return names;
}

/** Claude Code hook matcher semantics: regex anchored on the tool name; empty or `*` matches all. */
function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function apiUsage(u: ScriptUsage): SdkApiUsage {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: u.cacheCreateTokens,
    },
    cache_creation_input_tokens: u.cacheCreateTokens,
    cache_read_input_tokens: u.cacheReadTokens,
    fallback_credit: { status: { type: "redeemed" } },
    inference_geo: "",
    input_tokens: u.inputTokens,
    iterations: [],
    output_tokens: u.outputTokens,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  };
}

function modelUsage(u: ScriptUsage): SdkModelUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadTokens,
    cacheCreationInputTokens: u.cacheCreateTokens,
    webSearchRequests: 0,
    // The S0 gateway reported costBasis "unknown"; the Gateway prices tokens itself (ADR-0002 5).
    costUSD: 0,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    costBasis: "unknown",
  };
}

function textOfToolResult(value: unknown): { text: string; isError: boolean } {
  if (typeof value === "string") return { text: value, isError: false };
  if (value && typeof value === "object") {
    const r = value as { content?: unknown; isError?: unknown };
    const parts: string[] = [];
    if (Array.isArray(r.content)) {
      for (const block of r.content) {
        if (
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          parts.push((block as { text: string }).text);
        }
      }
    }
    return { text: parts.join("\n"), isError: r.isError === true };
  }
  return { text: "", isError: false };
}

export function createFakeSdk(source: ScriptSource, config: FakeSdkConfig = {}): FakeSdk {
  const sessions = new Map<string, FakeSession>();
  const servers = new WeakMap<object, InProcessServer>();
  const readOnly = new Set<string>(config.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS);
  const version = config.version ?? "0.3.278-fake";

  const scriptFor = (call: SdkQueryParams): readonly ScriptStep[] =>
    typeof source === "function" ? source(call) : source;

  const tool: FakeSdk["tool"] = (name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  });

  const createSdkMcpServer: FakeSdk["createSdkMcpServer"] = (options) => {
    const server: InProcessServer = { name: options.name, tools: new Map() };
    for (const t of options.tools ?? []) server.tools.set(t.name, t);
    const instance = {};
    servers.set(instance, server);
    // `instance` is opaque to callers; see SdkMcpServerConfigWithInstance for why it is `never`.
    return { type: "sdk", name: options.name, instance: instance as never };
  };

  function findInProcessTool(
    options: SdkQueryOptions,
    toolName: string,
  ): SdkToolDefinitionLoose | undefined {
    const m = /^mcp__([^_].*?)__(.+)$/.exec(toolName);
    if (!m) return undefined;
    const cfg = options.mcpServers?.[m[1] ?? ""];
    const inst = cfg?.instance;
    if (!inst || typeof inst !== "object") return undefined;
    return servers.get(inst)?.tools.get(m[2] ?? "");
  }

  async function execute(
    options: SdkQueryOptions,
    name: string,
    input: Record<string, unknown>,
    scripted: ScriptedResult,
  ): Promise<{ text: string; isError: boolean }> {
    const def = findInProcessTool(options, name);
    if (def) {
      // The loose definition is typed with `never` args so the real SDK's definitions fit; at
      // runtime the handler receives the validated input object exactly as the real server would.
      const invoke = def.handler as (args: unknown, extra: unknown) => Promise<unknown>;
      return textOfToolResult(await invoke(input, {}));
    }
    return { text: scripted.result ?? "", isError: scripted.isError === true };
  }

  async function pipeline(
    session: FakeSession,
    options: SdkQueryOptions,
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    scripted: ScriptedResult,
    signal: AbortSignal | undefined,
  ): Promise<PipelineOutcome> {
    const record: FakeToolCallRecord = {
      toolUseId,
      name,
      input,
      hookDecision: "none",
      executed: false,
      result: "",
    };
    session.toolCalls.push(record);
    const cwd = options.cwd ?? process.cwd();
    const hookSignal = signal ?? new AbortController().signal;

    // 0. The tool has to be on the model's list at all. A dropped tool never reaches the hook.
    if (!toolIsAvailable(options, name)) {
      record.unavailable = true;
      record.result = `tool ${name} is not available`;
      return { kind: "unavailable", text: record.result };
    }

    // 1. PreToolUse hooks, in registration order; deny wins over defer wins over ask/allow.
    let decision: SdkHookPermissionDecision | "none" = "none";
    let reason: string | undefined;
    let effectiveInput = input;
    const matchers: SdkHookMatcher[] = options.hooks?.PreToolUse ?? [];
    for (const matcher of matchers) {
      if (!matcherMatches(matcher.matcher, name)) continue;
      for (const hook of matcher.hooks) {
        const hookInput: SdkPreToolUseHookInput = {
          hook_event_name: "PreToolUse",
          session_id: session.id,
          transcript_path: `${cwd}/.claude/fake-transcript-${session.id}.jsonl`,
          cwd,
          tool_name: name,
          tool_input: effectiveInput,
          tool_use_id: toolUseId,
          ...(scripted.subagent === undefined
            ? {}
            : { agent_id: scripted.subagent.agentId, agent_type: scripted.subagent.agentType }),
        };
        // A hook that throws, or that runs past its matcher's timeout, leaves no decision: the
        // real CLI cancels it and moves on, and the call ends up at `canUseTool`.
        let out: SdkHookOutput;
        try {
          const raced = await withAbort(
            withHookTimeout(
              Promise.resolve().then(() => hook(hookInput, toolUseId, { signal: hookSignal })),
              matcher.timeout,
            ),
            signal,
          );
          if (raced === HOOK_TIMED_OUT) {
            record.hookTimedOut = true;
            continue;
          }
          out = raced;
        } catch (err) {
          if (isAbortError(err)) throw err;
          record.hookError = err instanceof Error ? err.message : String(err);
          continue;
        }
        const specific = out.hookSpecificOutput;
        if (specific?.updatedInput) effectiveInput = specific.updatedInput;
        const d = specific?.permissionDecision;
        if (d === undefined) continue;
        const rank: Record<SdkHookPermissionDecision | "none", number> = {
          none: 0,
          allow: 1,
          ask: 2,
          defer: 3,
          deny: 4,
        };
        if (rank[d] > rank[decision]) {
          decision = d;
          reason = specific?.permissionDecisionReason;
        }
      }
    }
    record.hookDecision = decision;
    if (reason !== undefined) record.hookReason = reason;

    if (decision === "deny") {
      record.result = reason ?? "Denied by PreToolUse hook";
      return { kind: "denied", text: record.result };
    }
    if (decision === "defer") return { kind: "defer" };

    // 2. Permission prompt: canUseTool, unless the hook allowed or the tool never prompts.
    if (
      decision !== "allow" &&
      !(decision === "none" && (readOnly.has(name) || options.allowedTools?.includes(name)))
    ) {
      if (!options.canUseTool) {
        record.result = "Permission prompt unavailable: no canUseTool callback";
        return { kind: "denied", text: record.result };
      }
      const verdict = await withAbort(
        options.canUseTool(name, effectiveInput, {
          signal: hookSignal,
          toolUseID: toolUseId,
          requestId: uuid(),
        }),
        signal,
      );
      if (verdict === null) {
        // Fail-closed, as the real SDK documents for a null control response.
        record.callbackDecision = "deny";
        record.result = "No control response for permission request";
        return { kind: "denied", text: record.result };
      }
      if (verdict.behavior === "deny") {
        record.callbackDecision = "deny";
        record.result = verdict.message;
        return { kind: "denied", text: verdict.message };
      }
      record.callbackDecision = "allow";
      if (verdict.updatedInput) effectiveInput = verdict.updatedInput;
    }

    // 3. Execute.
    const r = await execute(options, name, effectiveInput, scripted);
    record.executed = true;
    record.result = r.text;
    return { kind: "executed", text: r.text, isError: r.isError };
  }

  async function* run(params: SdkQueryParams): AsyncGenerator<SdkMessage, void, undefined> {
    const options = params.options ?? {};
    const signal = options.abortController?.signal;
    /** The model serving the session now; a `model_switch` step changes it. */
    let model = options.model ?? "";
    throwIfAborted(signal);

    const newSession = (id: string): FakeSession => {
      const s: FakeSession = {
        id,
        script: scriptFor(params),
        cursor: 0,
        deferred: undefined,
        calls: [],
        toolCalls: [],
        messages: [],
      };
      sessions.set(id, s);
      return s;
    };

    let session: FakeSession;
    let replay: FakeDeferredCall | undefined;
    if (options.resume !== undefined) {
      const existing = sessions.get(options.resume);
      if (existing) {
        session = existing;
        if (session.deferred) {
          replay = session.deferred;
          session.deferred = undefined;
        } else if (typeof source === "function") {
          session.script = source(params);
          session.cursor = 0;
        }
      } else {
        session = newSession(options.resume);
      }
    } else {
      session = newSession(uuid());
    }
    session.calls.push(params);

    const emit = <M extends SdkMessage>(m: M): M => {
      session.messages.push(m);
      return m;
    };

    const init: SdkSystemInitMessage = {
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      claude_code_version: version,
      cwd: options.cwd ?? process.cwd(),
      tools: offeredTools(options, session.script),
      mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({
        name,
        status: "connected",
      })),
      model,
      permissionMode: "default",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: uuid(),
      session_id: session.id,
    };
    await sessionStart(options.resume !== undefined);
    yield emit(init);

    let turns = 0;
    let lastText = "";
    /** Usage per model that served a turn, in first-served order, as `modelUsage` reports it. */
    const usageByModel = new Map<string, ScriptUsage>();
    const zeroUsage = (): ScriptUsage => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    const addUsage = (u: ScriptUsage) => {
      const totals = usageByModel.get(model) ?? zeroUsage();
      totals.inputTokens += u.inputTokens;
      totals.outputTokens += u.outputTokens;
      totals.cacheReadTokens += u.cacheReadTokens;
      totals.cacheCreateTokens += u.cacheCreateTokens;
      usageByModel.set(model, totals);
    };
    /**
     * The result's per-model usage and its sum. `extra` overrides the current model's entry,
     * which for a one-model session is exactly the old `{...totals, ...extra}`.
     */
    const resultUsage = (extra: Partial<ScriptUsage> | undefined) => {
      const perModel = new Map<string, ScriptUsage>();
      for (const [id, u] of usageByModel) perModel.set(id, { ...u });
      perModel.set(model, { ...(perModel.get(model) ?? zeroUsage()), ...extra });
      const sum = zeroUsage();
      for (const u of perModel.values()) {
        sum.inputTokens += u.inputTokens;
        sum.outputTokens += u.outputTokens;
        sum.cacheReadTokens += u.cacheReadTokens;
        sum.cacheCreateTokens += u.cacheCreateTokens;
      }
      const byModel: Record<string, SdkModelUsage> = {};
      for (const [id, u] of perModel) byModel[id] = modelUsage(u);
      return { sum, byModel };
    };

    const assistant = (
      content: SdkContentBlock[],
      stop: "end_turn" | "tool_use",
      turnUsage: ScriptUsage = DEFAULT_TURN_USAGE,
    ): SdkAssistantMessage => ({
      type: "assistant",
      message: {
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        stop_details: null,
        container: null,
        context_management: null,
        diagnostics: null,
        usage: apiUsage(turnUsage),
      },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: session.id,
    });

    const toolResult = (toolUseId: string, text: string, isError: boolean): SdkUserMessage => ({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: text,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: session.id,
    });

    const result = (
      text: string,
      extra: Partial<ScriptUsage> | undefined,
      deferred: FakeDeferredCall | undefined,
    ): SdkResultSuccessMessage => {
      const u = resultUsage(extra);
      const msg: SdkResultSuccessMessage = {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: turns,
        result: text,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: apiUsage(u.sum),
        modelUsage: u.byModel,
        permission_denials: [],
        uuid: uuid(),
        session_id: session.id,
      };
      if (deferred)
        msg.deferred_tool_use = {
          id: deferred.toolUseId,
          name: deferred.name,
          input: deferred.input,
        };
      return msg;
    };

    const failure = (errors: readonly string[]): SdkResultErrorMessage => {
      const u = resultUsage(undefined);
      return {
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: turns,
        stop_reason: null,
        total_cost_usd: 0,
        usage: apiUsage(u.sum),
        modelUsage: u.byModel,
        permission_denials: [],
        errors: [...errors],
        uuid: uuid(),
        session_id: session.id,
      };
    };

    /**
     * A model switch as the CLI reports it: every `PostModelSwitch` hook with the old and new
     * model, then the new model serves. A hook's output and its failure are both ignored.
     */
    async function sessionStart(resumed: boolean): Promise<void> {
      const cwd = options.cwd ?? process.cwd();
      const hookSignal = signal ?? new AbortController().signal;
      for (const matcher of options.hooks?.SessionStart ?? []) {
        for (const hook of matcher.hooks) {
          const input: SdkSessionStartHookInput = {
            hook_event_name: "SessionStart",
            session_id: session.id,
            transcript_path: `${cwd}/.claude/fake-transcript-${session.id}.jsonl`,
            cwd,
            source: resumed ? "resume" : "startup",
            model,
            ...(resumed ? (config.resumeFacts ?? {}) : {}),
          };
          try {
            await withAbort(
              withHookTimeout(
                Promise.resolve().then(() => hook(input, undefined, { signal: hookSignal })),
                matcher.timeout,
              ),
              signal,
            );
          } catch (err) {
            if (isAbortError(err)) throw err;
          }
        }
      }
    }

    async function switchModel(step: Extract<ScriptStep, { type: "model_switch" }>): Promise<void> {
      const to = step.to ?? options.fallbackModel?.split(",")[0]?.trim();
      if (to === undefined || to === "") {
        throw new Error("fake SDK script: model_switch has no `to` and no options.fallbackModel");
      }
      const cwd = options.cwd ?? process.cwd();
      const hookSignal = signal ?? new AbortController().signal;
      for (const matcher of options.hooks?.PostModelSwitch ?? []) {
        for (const hook of matcher.hooks) {
          const input: SdkPostModelSwitchHookInput = {
            hook_event_name: "PostModelSwitch",
            session_id: session.id,
            transcript_path: `${cwd}/.claude/fake-transcript-${session.id}.jsonl`,
            cwd,
            from_model: model,
            to_model: to,
            requested_model: step.requested === undefined ? to : step.requested,
            source: step.source ?? "auto",
            context_tokens: 0,
            prompt_cache_warm: false,
            cache_ttl: "5m",
            estimated_cache_write_usd: 0,
            pricing: "default",
          };
          try {
            await withAbort(
              withHookTimeout(
                Promise.resolve().then(() => hook(input, undefined, { signal: hookSignal })),
                matcher.timeout,
              ),
              signal,
            );
          } catch (err) {
            if (isAbortError(err)) throw err;
          }
        }
      }
      model = to;
    }

    /**
     * Compaction as the CLI does it: every `PreCompact` hook first, then the boundary. A hook's
     * output and its failure are both ignored here; the fake does not model a hook that blocks.
     */
    async function* compact(
      step: Extract<ScriptStep, { type: "compact" }>,
    ): AsyncGenerator<SdkMessage, void, undefined> {
      const trigger = step.trigger ?? "auto";
      const cwd = options.cwd ?? process.cwd();
      const hookSignal = signal ?? new AbortController().signal;
      for (const matcher of options.hooks?.PreCompact ?? []) {
        for (const hook of matcher.hooks) {
          const input: SdkPreCompactHookInput = {
            hook_event_name: "PreCompact",
            session_id: session.id,
            transcript_path: `${cwd}/.claude/fake-transcript-${session.id}.jsonl`,
            cwd,
            trigger,
            custom_instructions: null,
          };
          try {
            await withAbort(
              withHookTimeout(
                Promise.resolve().then(() => hook(input, undefined, { signal: hookSignal })),
                matcher.timeout,
              ),
              signal,
            );
          } catch (err) {
            if (isAbortError(err)) throw err;
          }
        }
      }
      const boundary: SdkCompactBoundaryMessage = {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger,
          pre_tokens: step.preTokens,
          ...(step.postTokens === undefined ? {} : { post_tokens: step.postTokens }),
        },
        uuid: uuid(),
        session_id: session.id,
      };
      yield emit(boundary);
    }

    const scriptedResultAt = (i: number): ScriptedResult => {
      const s = session.script[i];
      return s?.type === "tool_call"
        ? { result: s.result, isError: s.isError }
        : { result: undefined, isError: undefined };
    };

    // A deferred call from an earlier query() goes through the hook again before anything else.
    if (replay) {
      const outcome = await pipeline(
        session,
        options,
        replay.toolUseId,
        replay.name,
        replay.input,
        scriptedResultAt(replay.stepIndex),
        signal,
      );
      if (outcome.kind === "defer") {
        session.deferred = replay;
        yield emit(result(lastText, undefined, replay));
        return;
      }
      yield emit(
        toolResult(replay.toolUseId, outcome.text, outcome.kind !== "executed" || outcome.isError),
      );
      session.cursor = replay.stepIndex + 1;
    }

    while (session.cursor < session.script.length) {
      throwIfAborted(signal);
      const index = session.cursor;
      const step = session.script[index];
      if (!step) break;
      switch (step.type) {
        case "text": {
          turns += 1;
          const u = { ...DEFAULT_TURN_USAGE, ...step.usage };
          addUsage(u);
          lastText = step.text;
          yield emit(
            assistant([{ type: "text", text: step.text, citations: null }], "end_turn", u),
          );
          break;
        }
        case "streamed_text": {
          turns += 1;
          const u = { ...DEFAULT_TURN_USAGE, ...step.usage };
          addUsage(u);
          if (options.includePartialMessages) {
            for (const text of step.chunks) {
              yield emit({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text },
                },
                parent_tool_use_id: null,
                uuid: uuid(),
                session_id: session.id,
              });
            }
          }
          lastText = step.chunks.join("");
          yield emit(assistant([{ type: "text", text: lastText, citations: null }], "end_turn", u));
          break;
        }
        case "thinking": {
          // A thinking block adds to the totals only when the script gives it its own usage.
          if (step.usage) addUsage({ ...DEFAULT_TURN_USAGE, ...step.usage });
          yield emit(
            assistant([{ type: "thinking", thinking: step.text, signature: "" }], "end_turn", {
              ...DEFAULT_TURN_USAGE,
              ...step.usage,
            }),
          );
          break;
        }
        case "compact": {
          yield* compact(step);
          break;
        }
        case "model_switch": {
          await switchModel(step);
          break;
        }
        case "model_fallback": {
          const from = model;
          const to = step.to ?? options.fallbackModel?.split(",")[0]?.trim();
          if (to === undefined || to === "") {
            throw new Error(
              "fake SDK script: model_fallback has no `to` and no options.fallbackModel",
            );
          }
          const hook = step.hook ?? "none";
          if (hook === "before") await switchModel({ type: "model_switch", to, source: "auto" });
          const fallback: SdkModelFallbackMessage = {
            type: "system",
            subtype: "model_fallback",
            trigger: step.trigger ?? "overloaded",
            original_model: from,
            fallback_model: to,
            content: `Switched to ${to} due to high demand for ${from}`,
            uuid: uuid(),
            session_id: session.id,
          };
          // The real SDK sends this through its typed stream although `SDKMessage` does not
          // declare it; the fake does the same rather than widen `SdkMessage` past the real union.
          yield emit(fallback as unknown as SdkMessage);
          if (hook === "after") await switchModel({ type: "model_switch", to, source: "auto" });
          model = to;
          break;
        }
        case "api_retry": {
          const retry: SdkApiRetryMessage = {
            type: "system",
            subtype: "api_retry",
            attempt: step.attempt,
            max_retries: step.maxRetries ?? 10,
            retry_delay_ms: step.retryDelayMs ?? 1000,
            error_status: step.errorStatus === undefined ? null : step.errorStatus,
            error: step.error ?? "unknown",
            uuid: uuid(),
            session_id: session.id,
          };
          yield emit(retry);
          break;
        }
        case "fail": {
          session.cursor = index + 1;
          yield emit(failure(step.errors));
          return;
        }
        case "tool_call": {
          turns += 1;
          const u = { ...DEFAULT_TURN_USAGE, ...step.usage };
          addUsage(u);
          const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
          yield emit(
            assistant(
              [{ type: "tool_use", id: toolUseId, name: step.name, input: step.input }],
              "tool_use",
              u,
            ),
          );
          const outcome = await pipeline(
            session,
            options,
            toolUseId,
            step.name,
            step.input,
            { result: step.result, isError: step.isError, subagent: step.subagent },
            signal,
          );
          if (outcome.kind === "defer") {
            const deferred: FakeDeferredCall = {
              stepIndex: index,
              toolUseId,
              name: step.name,
              input: step.input,
            };
            session.deferred = deferred;
            yield emit(result(lastText, undefined, deferred));
            return;
          }
          yield emit(
            toolResult(toolUseId, outcome.text, outcome.kind !== "executed" || outcome.isError),
          );
          break;
        }
        case "end": {
          session.cursor = index + 1;
          yield emit(result(step.summary, step.usage, undefined));
          return;
        }
      }
      session.cursor = index + 1;
    }
    // Script exhausted without an explicit end: the real SDK still emits exactly one result.
    yield emit(result(lastText, undefined, undefined));
  }

  const contextUsageCalls: FakeSdk["contextUsageCalls"] = [];
  const query = (params: SdkQueryParams): FakeQuery =>
    Object.assign(run(params), {
      getContextUsage: async (opts?: { detail?: "summary" | "full" }) => {
        // The real SDK's default detail is `full`.
        const detail = opts?.detail ?? "full";
        contextUsageCalls.push({ detail });
        return config.contextUsage
          ? config.contextUsage(detail)
          : defaultContextUsage(params.options?.model ?? "");
      },
    });

  return { query, contextUsageCalls, tool, createSdkMcpServer, sessions };
}
