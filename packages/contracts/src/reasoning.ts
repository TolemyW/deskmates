// Reasoning settings as a recorded knob (measurement doc: "model name, cheap model, thinking
// switch"). The Agent SDK sends its own thinking and effort defaults when a run passes nothing
// (the thinking parameter probe of 2026-09-30 under `docs/design/`: adaptive thinking, effort
// high, on SDK 0.3.278), so "unset" is a real configuration and is recorded as such, never rewritten into a
// value the Gateway chose. Nothing here names a model: which levels a model accepts is the
// upstream's business, and a rejected value fails the run visibly rather than silently.

/** The SDK's effort levels (`EffortLevel` in sdk.d.ts), lowest first. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Mirrors the SDK's `ThinkingConfig`. `enabled` with a budget is the pre-4.6 shape; current
 * Claude models take `adaptive` or nothing, and some reject `disabled` outright. The Gateway
 * stores what the operator asked for and the SDK forwards it; whether the upstream accepts it is
 * measured, not assumed.
 */
export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens?: number }
  | { type: "disabled" };

/** Optional overrides carried by a bot definition or a run's config. Absent means SDK default. */
export interface ReasoningOverrides {
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
}

/** What the run row records: the value in force, or the fact that the SDK chose (decision: "sdk-default"). */
export interface RecordedReasoning {
  effort: EffortLevel | "sdk-default";
  thinking: ThinkingConfig | "sdk-default";
  /** Where the effort came from; `thinkingSource` likewise. */
  effortSource: "run" | "bot" | "sdk-default";
  thinkingSource: "run" | "bot" | "sdk-default";
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isThinkingConfig(value: unknown): value is ThinkingConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (v.type === "adaptive" || v.type === "disabled") return keys.length === 1;
  if (v.type === "enabled") {
    if (keys.length === 1) return true;
    return (
      keys.length === 2 &&
      typeof v.budgetTokens === "number" &&
      Number.isInteger(v.budgetTokens) &&
      v.budgetTokens > 0
    );
  }
  return false;
}

/**
 * The reasoning a run starts with: the run's own override, else the bot's, else the SDK default.
 * `recorded` is what goes on the run row; `request` is what the sidecar receives, which carries
 * a key only when something was set, so an unset knob reaches the SDK as nothing at all.
 */
export function resolveReasoning(
  run: ReasoningOverrides,
  bot: ReasoningOverrides,
): { recorded: RecordedReasoning; request: ReasoningOverrides } {
  const effort = run.effort ?? bot.effort;
  const thinking = run.thinking ?? bot.thinking;
  return {
    recorded: {
      effort: effort ?? "sdk-default",
      thinking: thinking ?? "sdk-default",
      effortSource:
        run.effort !== undefined ? "run" : bot.effort !== undefined ? "bot" : "sdk-default",
      thinkingSource:
        run.thinking !== undefined ? "run" : bot.thinking !== undefined ? "bot" : "sdk-default",
    },
    request: {
      ...(effort === undefined ? {} : { effort }),
      ...(thinking === undefined ? {} : { thinking }),
    },
  };
}

/** Reads the overrides back out of a recorded value (a resume keeps attempt 1's settings). */
export function overridesOfRecorded(recorded: RecordedReasoning): ReasoningOverrides {
  return {
    ...(recorded.effort === "sdk-default" ? {} : { effort: recorded.effort }),
    ...(recorded.thinking === "sdk-default" ? {} : { thinking: recorded.thinking }),
  };
}

export function isRecordedReasoning(value: unknown): value is RecordedReasoning {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.effort === "sdk-default" || isEffortLevel(v.effort)) &&
    (v.thinking === "sdk-default" || isThinkingConfig(v.thinking))
  );
}
