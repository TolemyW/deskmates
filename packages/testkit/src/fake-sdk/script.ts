// A script is what the fake model "does" during one query(): say things, call tools, finish.

import type { SdkApiRetryError, SdkModelSwitchSource, SdkQueryParams } from "./sdk-shapes.js";

export interface ScriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/**
 * `usage` on an assistant step is what that assistant message's `message.usage` reports (the
 * window the model saw on that turn); absent means the fake's default per-turn usage.
 */
export type ScriptStep =
  /** Assistant text block. */
  | { type: "text"; text: string; usage?: Partial<ScriptUsage> }
  /** Assistant thinking block. */
  | { type: "thinking"; text: string; usage?: Partial<ScriptUsage> }
  /**
   * Assistant tool_use block. `result` is what the tool returns when the call is allowed; for an
   * in-process SDK MCP tool registered via the fake's `createSdkMcpServer` the handler's output
   * wins over `result`. When the hook or callback denies, the deny reason is the result instead.
   * `isError` makes an allowed call come back as a failed tool_result (`is_error: true`), the way
   * a browser click on a `ref` from a snapshot the session no longer has does.
   */
  | {
      type: "tool_call";
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      usage?: Partial<ScriptUsage>;
      /**
       * The call is made inside a subagent: the PreToolUse hook input carries `agent_id` and
       * `agent_type`, as the real SDK sets them for a subagent's tool calls.
       */
      subagent?: { agentId: string; agentType: string };
    }
  /**
   * The CLI compacts the conversation: every `PreCompact` hook runs first (a throw or any output
   * is ignored, compaction goes ahead), then a `system` / `compact_boundary` message is emitted
   * with `compact_metadata` from this step.
   */
  | {
      type: "compact";
      trigger?: "manual" | "auto";
      preTokens: number;
      postTokens?: number;
    }
  /**
   * The SDK retries a failed request: a `system` / `api_retry` message. The retried request is
   * not a turn and adds no usage.
   */
  | {
      type: "api_retry";
      attempt: number;
      maxRetries?: number;
      retryDelayMs?: number;
      /** HTTP status of the failure; null for a connection error with no response. */
      errorStatus?: number | null;
      error?: SdkApiRetryError;
    }
  /**
   * The session's model changes: every `PostModelSwitch` hook runs (a throw is ignored), then
   * later assistant messages carry the new model and their usage is reported under it in
   * `modelUsage`. `to` defaults to the first entry of `options.fallbackModel`, which is what the
   * SDK switches to on an overloaded primary; a step with neither is a script error.
   */
  | {
      type: "model_switch";
      to?: string;
      source?: SdkModelSwitchSource;
      requested?: string | null;
    }
  /**
   * An overload fallback as SDK 0.3.278 reports it: a `system` / `model_fallback` message and no
   * `PostModelSwitch` hook, then the fallback serves like after a `model_switch`. `to` defaults to
   * the first entry of `options.fallbackModel`. `hook` also runs the `PostModelSwitch` hooks
   * (source `auto`) before or after the message, for an SDK that sends both signals; the default
   * `none` is what 0.3.278 does.
   */
  | {
      type: "model_fallback";
      to?: string;
      trigger?: string;
      hook?: "none" | "before" | "after";
    }
  /** The run fails: an `error_during_execution` result carrying `errors`, then nothing more. */
  | { type: "fail"; errors: readonly string[] }
  /**
   * Final `result` message. `summary` becomes `result.result` (the final assistant text the real
   * SDK reports). `usage` feeds `usage` and `modelUsage` on the result message; with more than
   * one model in the session it overrides the current model's entry only.
   */
  | { type: "end"; summary: string; usage?: Partial<ScriptUsage> };

/** A script per call, so a test can vary the model's behaviour by prompt or session. */
export type ScriptSource =
  | readonly ScriptStep[]
  | ((call: SdkQueryParams) => readonly ScriptStep[]);
