// How the run's system prompt reaches the SDK (ADR-0023 amendment 5, decision 23). The static
// part (SOUL.md and the workspace guidance, the same for every run of a bot in the same kind of
// thread) goes before the SDK's dynamic boundary marker; the sections chosen per run go after it.
// Blocks before the marker are what the CLI may cache across sessions; with an upstream that does
// not split cache scopes the CLI drops the marker and joins the blocks with a blank line, which
// is byte for byte the single string every earlier run sent (`systemPromptText`).
//
// `snapshot: true` asks the CLI to record the prompt on the session's first request and re-send
// that record on every later request and resume. It is the SDK's documented default for a custom
// prompt; it is set explicitly so the cached prefix of a resumed session cannot change under it.

import type {
  Options,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY as SdkBoundary,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, typed as the SDK declares it, so a different marker
 * in a later SDK fails the typecheck. A value, not an import: only `real-deps.ts` loads the SDK's
 * runtime.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY: typeof SdkBoundary =
  "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/** The system prompt split at the boundary; `dynamic` is empty for most runs. */
export interface SystemPromptParts {
  static: string;
  dynamic: readonly string[];
}

/** The SDK option for a run's system prompt. */
export function sdkSystemPrompt(parts: SystemPromptParts): NonNullable<Options["systemPrompt"]> {
  return {
    type: "custom",
    prompt: [parts.static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...parts.dynamic],
    snapshot: true,
  };
}

/**
 * The text a system prompt option stands for: a string as it is, blocks joined by one blank line
 * with the boundary marker dropped, the way the CLI renders them when it keeps one cache scope.
 * Takes `unknown` so a test can hand it the fake SDK's recorded option; a preset prompt, or
 * anything else, has no text of ours and reads as "".
 */
export function systemPromptText(option: unknown): string {
  if (typeof option === "string") return option;
  const custom = option as { type?: unknown; prompt?: unknown } | null | undefined;
  const blocks: unknown = Array.isArray(option)
    ? option
    : custom?.type === "custom"
      ? typeof custom.prompt === "string"
        ? [custom.prompt]
        : custom.prompt
      : [];
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b): b is string => typeof b === "string")
    .filter((b) => b !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY && b !== "")
    .join("\n\n");
}
