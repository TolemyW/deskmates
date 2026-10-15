// Shared-browser knobs: tab retention and the opt-in execution, coordination and snapshot modes.

import {
  type BrowserCodeApproval,
  type BrowserCoordinationMode,
  type BrowserSnapshotMode,
  DeskmatesError,
} from "@deskmates/contracts";
import { type Env, optionalInt } from "./env.js";

export interface BrowserConfig {
  /** ADR-0007 opt-in experiment; omitted configuration preserves tab-v1. */
  browserCoordinationMode?: BrowserCoordinationMode;
  /** Opt-in inline page-state experiment; omitted preserves explicit snapshots. */
  browserSnapshotMode?: BrowserSnapshotMode;
  browserExecutionMode?: "vision-cli-v2";
  /** ADR-0002 amendment 5 (proposed): how browser code is tiered; omitted preserves name-v1. */
  browserCodeApproval?: BrowserCodeApproval;
  browserRetainedTabs?: number;
  browserTabRetentionHours?: number;
}

export function readBrowserConfig(env: Env): BrowserConfig {
  return {
    browserRetainedTabs: optionalInt(env, "BROWSER_RETAINED_TABS", 20),
    browserTabRetentionHours: optionalInt(env, "BROWSER_TAB_RETENTION_HOURS", 24),
    ...browserExecution(env),
    browserCoordinationMode: browserCoordinationMode(env),
    browserSnapshotMode: browserSnapshotMode(env),
    browserCodeApproval: browserCodeApproval(env),
  };
}

/** `BROWSER_CODE_APPROVAL`: `name-v1` (default) or the opt-in `effects-v1` (ADR-0002 amendment 5). */
function browserCodeApproval(env: Env): BrowserCodeApproval {
  const value = env.BROWSER_CODE_APPROVAL?.trim() || "name-v1";
  if (value !== "name-v1" && value !== "effects-v1")
    throw new DeskmatesError("validation", "BROWSER_CODE_APPROVAL must be name-v1 or effects-v1");
  return value;
}

function browserCoordinationMode(env: Env): BrowserCoordinationMode {
  const value = env.BROWSER_COORDINATION_MODE?.trim() || "tab-v1";
  if (value !== "tab-v1" && value !== "origin-v2")
    throw new DeskmatesError("validation", "BROWSER_COORDINATION_MODE must be tab-v1 or origin-v2");
  return value;
}

function browserSnapshotMode(env: Env): BrowserSnapshotMode {
  const value = env.BROWSER_SNAPSHOT_MODE?.trim() || "explicit-v1";
  if (value !== "explicit-v1" && value !== "inline-v2")
    throw new DeskmatesError(
      "validation",
      "BROWSER_SNAPSHOT_MODE must be explicit-v1 or inline-v2",
    );
  return value;
}

function browserExecution(env: Env): { browserExecutionMode?: "vision-cli-v2" } {
  const value = env.BROWSER_EXECUTION_MODE?.trim();
  if (!value || value === "baseline-v1") return {};
  if (value === "vision-cli-v2") return { browserExecutionMode: value };
  throw new DeskmatesError(
    "validation",
    "BROWSER_EXECUTION_MODE must be baseline-v1 or vision-cli-v2",
  );
}
