// What the CLI offers the model beyond the sidecar's fixed configuration (ADR-0023 amendment 5,
// decision 24): extra built-in tools to withhold and three of the SDK's inline `settings`
// switches. Every variable is optional and empty means "as before": no extra tool is withheld and
// the CLI keeps its own defaults. The values are stamped on each run row at creation and a run's
// every process reads them from there, so a resumed session never sees a different tool set.

import { type CliSurface, DeskmatesError } from "@deskmates/contracts";
import { type Env, optionalInt } from "./env.js";

export interface CliSurfaceConfig {
  /** Absent when no variable is set: nothing changes. */
  cliSurface?: CliSurface;
}

/**
 * A built-in CLI tool name: PascalCase, as the CLI names its own tools. An MCP tool
 * (`mcp__server__tool`) does not match; this knob trims the CLI's tools, not Deskmates' own.
 */
const BUILTIN_TOOL_NAME = /^[A-Z][A-Za-z0-9_]*$/;

function toolList(env: Env, key: string): string[] {
  const raw = env[key]?.trim() ?? "";
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const name of names) {
    if (!BUILTIN_TOOL_NAME.test(name))
      throw new DeskmatesError("validation", `${key} names a tool that is not a built-in name`, {
        key,
        name,
      });
  }
  return [...new Set(names)];
}

function optionalBoolean(env: Env, key: string): boolean | undefined {
  const raw = env[key]?.trim().toLowerCase() ?? "";
  if (raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new DeskmatesError("validation", `${key} must be true, false or empty`, { key, raw });
}

export function readCliSurfaceConfig(env: Env): CliSurfaceConfig {
  const disallowedTools = toolList(env, "DESKMATES_CLI_DISALLOWED_TOOLS");
  const disableBundledSkills = optionalBoolean(env, "DESKMATES_CLI_DISABLE_BUNDLED_SKILLS");
  const includeGitInstructions = optionalBoolean(env, "DESKMATES_CLI_INCLUDE_GIT_INSTRUCTIONS");
  const maxDesc = env.DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS?.trim()
    ? optionalInt(env, "DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS", 1)
    : undefined;
  const surface: CliSurface = {
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(disableBundledSkills === undefined ? {} : { disableBundledSkills }),
    ...(includeGitInstructions === undefined ? {} : { includeGitInstructions }),
    ...(maxDesc === undefined ? {} : { skillListingMaxDescChars: maxDesc }),
  };
  return Object.keys(surface).length > 0 ? { cliSurface: surface } : {};
}

/**
 * The `runs.config_json` stamp: the effective values, `null` meaning the CLI's own default, so a
 * run row says what the run was offered even when nothing was trimmed. The sidecar's fixed
 * withheld tools are not listed; they belong to its release (`DISALLOWED_TOOLS`).
 */
export function cliSurfaceStamp(config: CliSurfaceConfig): { cliSurface: Record<string, unknown> } {
  const s = config.cliSurface ?? {};
  return {
    cliSurface: {
      version: 1,
      disallowedTools: [...(s.disallowedTools ?? [])],
      disableBundledSkills: s.disableBundledSkills ?? null,
      includeGitInstructions: s.includeGitInstructions ?? null,
      skillListingMaxDescChars: s.skillListingMaxDescChars ?? null,
    },
  };
}

/**
 * The start request's field, read back from a run row's stamp. A row from before the knob, or a
 * stamp with nothing set, sends nothing; a value of the wrong shape is ignored rather than
 * forwarded to the CLI unvalidated.
 */
export function cliSurfaceStart(config: Record<string, unknown>): { cliSurface?: CliSurface } {
  const raw = config.cliSurface;
  if (raw === null || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const tools = Array.isArray(r.disallowedTools)
    ? r.disallowedTools.filter(
        (t): t is string => typeof t === "string" && BUILTIN_TOOL_NAME.test(t),
      )
    : [];
  const maxDesc = r.skillListingMaxDescChars;
  const surface: CliSurface = {
    ...(tools.length > 0 ? { disallowedTools: tools } : {}),
    ...(typeof r.disableBundledSkills === "boolean"
      ? { disableBundledSkills: r.disableBundledSkills }
      : {}),
    ...(typeof r.includeGitInstructions === "boolean"
      ? { includeGitInstructions: r.includeGitInstructions }
      : {}),
    ...(typeof maxDesc === "number" && Number.isSafeInteger(maxDesc) && maxDesc > 0
      ? { skillListingMaxDescChars: maxDesc }
      : {}),
  };
  return Object.keys(surface).length > 0 ? { cliSurface: surface } : {};
}
