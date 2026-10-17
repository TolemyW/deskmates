// The OpenAI Agents SDK as a second agent loop (ADR-0044). `runOnce` hands it the same prompt and
// options it would hand the Claude SDK; this module runs the loop in-process and yields
// messages shaped like the Claude SDK's, so the ledger, approvals, taint and handoff code never
// learn which runtime ran.
//
// One gate for both runtimes (decision 2): before any tool runs, the sidecar's PreToolUse hook is
// called with the Agents SDK call id as the tool-use id. `allow` runs the tool; `deny` becomes the
// tool's result, with the reason; `defer` is raised through the SDK's `needsApproval`, the run
// pauses at the end of the turn, its `RunState` is written beside the session file, and the run
// ends as `deferred` (the hook already recorded the approval id). On resume (decision 3) the
// pending interruptions are judged by the same hook, which turns the `approval` trigger into
// allow or deny, and the state is approved or rejected and run on.
//
// The model's raw stream is turned into the Claude SDK's `stream_event`s (message_start, text
// deltas, message_delta with usage, message_stop), which feed the reply preview and the per-turn
// usage events; images a tool returns travel to the model through `model-wrapper.ts`, and so
// does compaction when `DESKMATES_OPENAI_MAX_CONTEXT_TOKENS` is set (`compaction.ts`).
//
// Not on this runtime: subagents (`Agent`/`Task`), a fallback model (ADR-0044 consequences).

import { randomUUID } from "node:crypto";
import type { HookCallback, HookInput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Agent,
  type AgentInputItem,
  type AgentOutputType,
  MaxTurnsExceededError,
  type ModelProvider,
  OpenAIProvider,
  RunState,
  type RunToolApprovalItem,
  Runner,
  type StreamedRunResult,
  setTracingDisabled,
  tool,
} from "@openai/agents";
import { systemPromptText } from "../../system-prompt.js";
import { builtinTools } from "./builtin-tools.js";
import { FileSession, sessionDirOf } from "./file-session.js";
import { connectMcpServers } from "./mcp-tools.js";
import { wrapModel } from "./model-wrapper.js";
import {
  type ModelUsageTotals,
  assistantText,
  assistantThinking,
  assistantToolUse,
  compactBoundaryMessage,
  contentBlockStartEvent,
  initMessage,
  messageDeltaEvent,
  messageStartEvent,
  messageStopEvent,
  resultMessage,
  textDeltaEvent,
  toolResultMessage,
} from "./sdk-messages.js";
import { skillTool } from "./skill-tool.js";
import type { OpenAiQueryFn, OpenAiQueryParams, ToolImage, ToolSpec } from "./types.js";

/**
 * The non-strict JSON schema shape `tool()` accepts (`JsonObjectSchemaNonStrict`, which the SDK
 * does not export by name): the model sees the tool's own schema, parsed but not validated.
 */
interface NonStrictSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: true;
  description?: string;
}

function nonStrictSchema(schema: Record<string, unknown>): NonStrictSchema {
  const properties = schema.properties;
  const required = schema.required;
  return {
    type: "object",
    properties:
      properties && typeof properties === "object"
        ? (properties as Record<string, Record<string, unknown>>)
        : {},
    required: Array.isArray(required)
      ? required.filter((r): r is string => typeof r === "string")
      : [],
    additionalProperties: true,
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
  };
}

/** The Agents SDK's default turn cap is 10; a workspace with the cap `off` gets this instead. */
const UNCAPPED_TURNS = 1_000_000;
const SDK_VERSION = "0.20.0";

type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "defer"; reason: string };

export interface OpenAiRuntimeOptions {
  /** Process environment forwarded to stdio MCP servers (the browser proxy); tests pass little. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: skip stdio MCP servers (the browser proxy binary is not on a test machine). */
  attachStdio?: boolean;
  /** Test seam: where file and shell tools run instead of the request's working directory. */
  cwdOverride?: string;
  now?: () => Date;
}

export function createOpenAiQuery(opts: OpenAiRuntimeOptions = {}): OpenAiQueryFn {
  setTracingDisabled(true);
  return (params) => runOpenAi(params, opts);
}

function firstHook(
  options: Options,
  event: "PreToolUse" | "PostToolUse",
): HookCallback | undefined {
  return options.hooks?.[event]?.[0]?.hooks?.[0];
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(outputText).join("\n");
  if (output && typeof output === "object") {
    const o = output as { type?: unknown; text?: unknown };
    if (o.type === "text" && typeof o.text === "string") return o.text;
    return JSON.stringify(output);
  }
  return String(output ?? "");
}

interface SdkUsage {
  inputTokens: number;
  outputTokens: number;
  inputTokensDetails?: Record<string, number> | Array<Record<string, number>>;
}

function cachedOf(usage: SdkUsage): number {
  const details = usage.inputTokensDetails;
  if (Array.isArray(details)) return details.reduce((n, d) => n + (d.cached_tokens ?? 0), 0);
  return details?.cached_tokens ?? 0;
}

function usageTotals(usage: SdkUsage): ModelUsageTotals {
  const cached = cachedOf(usage);
  // The Claude SDK counts cache reads outside `input_tokens`; OpenAI counts them inside
  // `prompt_tokens`. Report the Claude way so one price table applies to both runtimes.
  return {
    inputTokens: Math.max(0, usage.inputTokens - cached),
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: cached,
  };
}

function usageDelta(now: ModelUsageTotals, baseline: ModelUsageTotals): ModelUsageTotals {
  return {
    inputTokens: Math.max(0, now.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, now.outputTokens - baseline.outputTokens),
    cacheReadInputTokens: Math.max(0, now.cacheReadInputTokens - baseline.cacheReadInputTokens),
  };
}

async function* runOpenAi(
  params: OpenAiQueryParams,
  opts: OpenAiRuntimeOptions,
): AsyncGenerator<SDKMessage> {
  const { options } = params;
  const env = opts.env ?? process.env;
  const cwd = opts.cwdOverride ?? params.cwd;
  const now = opts.now ?? (() => new Date());
  const startedAt = Date.now();
  const model = options.model ?? "";
  const sessionId = options.resume ?? randomUUID();
  const session = await FileSession.open(sessionDirOf(params.botHomeDir), sessionId);
  const preToolUse = firstHook(options, "PreToolUse");
  const postToolUse = firstHook(options, "PostToolUse");
  // The same text the Claude path sends, static and dynamic parts joined (ADR-0023 amendment 5).
  const systemPrompt = systemPromptText(options.systemPrompt);

  /** The gate's answer per call id, so `execute` and a resume never ask twice for one call. */
  const decisions = new Map<string, GateDecision>();
  /** Calls whose result the model should see as an error. */
  const erroredCalls = new Set<string>();
  /** Images tools returned, by call id, carried to the model by the model wrapper. */
  const images = new Map<string, ToolImage>();
  /** Messages produced outside the event stream (a compaction), yielded at the next event. */
  const pendingMessages: SDKMessage[] = [];
  /** Prompt tokens the last response reported, cached part included (compaction judges it). */
  let lastPromptTokens = session.lastPromptTokens;

  async function gate(
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
  ): Promise<GateDecision> {
    // No hook means no gate; the sidecar always installs one, so this is fail-closed, not a path.
    if (preToolUse === undefined) return { kind: "deny", reason: "no tool gate installed" };
    const hookInput = {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      transcript_path: "",
      cwd,
      permission_mode: "default",
      tool_name: toolName,
      tool_input: input,
      tool_use_id: callId,
    } as HookInput;
    let output: Awaited<ReturnType<HookCallback>>;
    try {
      output = await preToolUse(hookInput, callId, { signal: new AbortController().signal });
    } catch (err) {
      return { kind: "deny", reason: `tool gate failed: ${String(err)}` };
    }
    const specific = (
      output as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      }
    ).hookSpecificOutput;
    const reason = specific?.permissionDecisionReason ?? "";
    switch (specific?.permissionDecision) {
      case "allow":
        return { kind: "allow" };
      case "defer":
        return { kind: "defer", reason };
      default:
        return { kind: "deny", reason: reason || "denied by the tool gate" };
    }
  }

  async function postTool(
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
    text: string,
  ): Promise<string> {
    if (postToolUse === undefined) return text;
    try {
      const output = await postToolUse(
        {
          hook_event_name: "PostToolUse",
          session_id: sessionId,
          transcript_path: "",
          cwd,
          tool_name: toolName,
          tool_input: input,
          tool_use_id: callId,
          tool_response: text,
        } as HookInput,
        callId,
        { signal: new AbortController().signal },
      );
      const extra = (output as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext;
      return extra ? `${text}\n\n${extra}` : text;
    } catch {
      return text;
    }
  }

  function gatedTool(spec: ToolSpec) {
    return tool({
      name: spec.name,
      description: spec.description,
      parameters: nonStrictSchema(spec.parameters),
      strict: false,
      needsApproval: async (_ctx, input, callId) => {
        const id = callId ?? randomUUID();
        // Asked again on a resumed state and after an in-process approval: the call was judged
        // once, and asking the hook twice would post a second approval for the same call.
        const known = decisions.get(id);
        if (known !== undefined) return known.kind === "defer";
        const decision = await gate(spec.name, parseArguments(input), id);
        decisions.set(id, decision);
        return decision.kind === "defer";
      },
      execute: async (input, _ctx, details) => {
        const id = details?.toolCall?.callId ?? randomUUID();
        const args = parseArguments(input);
        const decision = decisions.get(id) ?? (await gate(spec.name, args, id));
        decisions.set(id, decision);
        if (decision.kind !== "allow") {
          erroredCalls.add(id);
          return decision.reason;
        }
        const outcome = await spec.run(args, details?.signal);
        if (outcome.isError) erroredCalls.add(id);
        // One image per call reaches the model; the first is the page, the rest are rare.
        const image = outcome.images?.[0];
        if (image !== undefined) images.set(id, image);
        return postTool(spec.name, args, id, outcome.text);
      },
    });
  }

  const servers = await connectMcpServers(options.mcpServers, env, opts.attachStdio ?? true);
  const specs: ToolSpec[] = [
    ...builtinTools(cwd),
    ...(params.skills && params.skills.names.length > 0 ? [skillTool(params.skills)] : []),
    ...servers.flatMap((s) => s.tools),
  ];
  const agent: Agent<unknown, AgentOutputType> = new Agent({
    name: params.botName,
    instructions: systemPrompt,
    model,
    tools: specs.map(gatedTool),
  });
  const provider = new OpenAIProvider({
    baseURL: `${params.modelBaseUrl.replace(/\/+$/, "")}/v1`,
    apiKey: params.modelAuthToken,
    useResponses: false,
  });
  const modelProvider: ModelProvider = {
    getModel: async (name) =>
      wrapModel(await provider.getModel(name), {
        images,
        lastPromptTokens: () => lastPromptTokens,
        maxContextTokens: params.maxContextTokens,
        onCompacted: async ({ preTokens, items }) => {
          await session.compactTo(items, now());
          lastPromptTokens = undefined;
          pendingMessages.push(compactBoundaryMessage(sessionId, preTokens));
        },
      }),
  };
  const runner = new Runner({ modelProvider, tracingDisabled: true });
  const maxTurns = options.maxTurns ?? UNCAPPED_TURNS;

  yield initMessage({
    sessionId,
    model,
    cwd,
    tools: specs.map((s) => s.name),
    mcpServers: servers.map((s) => s.name),
    sdkVersion: SDK_VERSION,
  });

  let baseline: ModelUsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  let latest: ModelUsageTotals = baseline;
  let numTurns = 0;
  let turnId = 0;
  let lastText = "";
  const settle = async () => {
    const delta = usageDelta(latest, baseline);
    baseline = latest;
    if (delta.inputTokens + delta.outputTokens + delta.cacheReadInputTokens > 0)
      await session.addUsage({ [model]: delta });
  };
  const messageIdOf = (turn: number) => `msg_${sessionId.slice(0, 8)}_${turn}`;

  try {
    let input: string | AgentInputItem[] | RunState<unknown, typeof agent> = params.prompt;
    const parked = options.resume === undefined ? undefined : await session.loadState();
    if (parked !== undefined) {
      const state = await RunState.fromString(agent, parked);
      baseline = usageTotals(state.usage);
      latest = baseline;
      let stillParked = false;
      for (const item of state.getInterruptions()) {
        const decision = await judgeInterruption(item);
        if (decision.kind === "allow") state.approve(item);
        else if (decision.kind === "deny") state.reject(item, { message: decision.reason });
        else stillParked = true;
      }
      if (stillParked) {
        await session.saveState(state.toString());
        yield resultMessage({
          sessionId,
          durationMs: Date.now() - startedAt,
          numTurns,
          totals: session.totals,
          outcome: { kind: "success", text: "" },
        });
        return;
      }
      input = state;
    }

    for (;;) {
      const streamed: StreamedRunResult<unknown, typeof agent> = await runner.run(agent, input, {
        stream: true,
        maxTurns,
        session,
      });
      for await (const event of streamed) {
        while (pendingMessages.length > 0) yield pendingMessages.shift() as SDKMessage;
        if (event.type === "raw_model_stream_event") {
          const data = event.data;
          if (data.type === "response_started") {
            numTurns += 1;
            turnId += 1;
            yield messageStartEvent(sessionId, messageIdOf(turnId), model);
            yield contentBlockStartEvent(sessionId);
          } else if (data.type === "output_text_delta") {
            yield textDeltaEvent(sessionId, data.delta);
          } else if (data.type === "response_done") {
            const usage = data.response.usage as SdkUsage;
            lastPromptTokens = usage.inputTokens;
            await session.setLastPromptTokens(usage.inputTokens);
            yield messageDeltaEvent(sessionId, usageTotals(usage));
            yield messageStopEvent(sessionId);
          }
          continue;
        }
        if (event.type !== "run_item_stream_event") continue;
        const raw = event.item.rawItem as Record<string, unknown> | undefined;
        const messageId = messageIdOf(turnId);
        if (event.name === "message_output_created") {
          const text = outputText(
            Array.isArray(raw?.content)
              ? (raw?.content as Record<string, unknown>[])
                  .filter((c) => c.type === "output_text")
                  .map((c) => c.text)
                  .join("")
              : raw?.content,
          );
          lastText = text;
          yield assistantText(sessionId, messageId, model, text);
        } else if (event.name === "reasoning_item_created") {
          const text = Array.isArray(raw?.content)
            ? (raw?.content as Record<string, unknown>[]).map((c) => String(c.text ?? "")).join("")
            : "";
          if (text) yield assistantThinking(sessionId, messageId, model, text);
        } else if (event.name === "tool_called" && raw?.type === "function_call") {
          yield assistantToolUse(sessionId, messageId, model, {
            id: String(raw.callId),
            name: String(raw.name),
            input: parseArguments(raw.arguments),
          });
        } else if (event.name === "tool_output" && raw?.type === "function_call_result") {
          const callId = String(raw.callId);
          yield toolResultMessage(sessionId, {
            toolUseId: callId,
            text: outputText(raw.output),
            isError: erroredCalls.has(callId),
          });
        }
      }
      await streamed.completed;
      while (pendingMessages.length > 0) yield pendingMessages.shift() as SDKMessage;
      latest = usageTotals(streamed.state.usage);
      const interruptions = streamed.interruptions ?? [];
      if (interruptions.length === 0) break;
      let stillParked = false;
      for (const item of interruptions) {
        const decision = await judgeInterruption(item);
        if (decision.kind === "allow") streamed.state.approve(item);
        else if (decision.kind === "deny")
          streamed.state.reject(item, { message: decision.reason });
        else stillParked = true;
      }
      if (stillParked) {
        await session.saveState(streamed.state.toString());
        await settle();
        yield resultMessage({
          sessionId,
          durationMs: Date.now() - startedAt,
          numTurns,
          totals: session.totals,
          outcome: { kind: "success", text: lastText },
        });
        return;
      }
      input = streamed.state;
    }
    await session.clearState();
    await settle();
    yield resultMessage({
      sessionId,
      durationMs: Date.now() - startedAt,
      numTurns,
      totals: session.totals,
      outcome: { kind: "success", text: lastText },
    });
  } catch (err) {
    await settle().catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    yield resultMessage({
      sessionId,
      durationMs: Date.now() - startedAt,
      numTurns,
      totals: session.totals,
      outcome: {
        kind: err instanceof MaxTurnsExceededError ? "error_max_turns" : "error_during_execution",
        errors: [message],
      },
    });
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }

  /**
   * A pending interruption is judged by the gate unless this process already judged it `defer`:
   * asking again would post a second approval for the same call. In a resumed process the map is
   * empty, so the hook sees the call and applies the human's decision from the trigger.
   */
  async function judgeInterruption(item: RunToolApprovalItem): Promise<GateDecision> {
    const raw = item.rawItem as { callId?: unknown; name?: unknown; arguments?: unknown };
    const callId = typeof raw.callId === "string" ? raw.callId : randomUUID();
    const known = decisions.get(callId);
    if (known !== undefined) return known;
    const decision = await gate(
      typeof raw.name === "string" ? raw.name : "",
      parseArguments(raw.arguments),
      callId,
    );
    decisions.set(callId, decision);
    return decision;
  }
}
