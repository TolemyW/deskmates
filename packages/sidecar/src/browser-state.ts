// Per-run browser metadata. Shared workspace data, never credentials or an access boundary.
import type { BrowserSnapshotMode, RunId } from "@deskmates/contracts";

export const BROWSER_COORDINATION_ENV = "DESKMATES_BROWSER_COORDINATION";
export interface BrowserTab {
  id: string;
  url: string;
  current: boolean;
}
export interface BrowserState {
  version: 1;
  runId: RunId;
  tabId?: string;
  tabs: BrowserTab[];
}
export interface BrowserCoordinationConfig {
  runId: RunId;
  screenSlot?: number;
  /** Run attempt used only for Gateway-owned telemetry sequencing. */
  attempt?: number;
  gatewayBaseUrl: string;
  token: string;
  statePath: string;
  /** Opt-in ADR-0007 prototype. Absent keeps the established per-tab v1 behavior. */
  mode?: "origin-v2";
  /** Absolute Gateway-owned run deadline; origin queue time consumes this same wall clock. */
  deadlineAt?: string;
  /** Present only for the opt-in prototype; absent and explicit-v1 keep the established path. */
  snapshotMode?: Extract<BrowserSnapshotMode, "inline-v2">;
  /** Opt-in browser execution strategy; omitted keeps the evaluated MCP-only behavior. */
  browserExecutionMode?: "vision-cli-v2";
}
export function browserStatePath(home: string, runId: RunId): string {
  return `${home}/.deskmates/browser/${runId}.json`;
}
export function parseBrowserState(text: string, runId: RunId): BrowserState | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return undefined;
    const state = value as Partial<BrowserState>;
    if (state.version !== 1 || state.runId !== runId || !Array.isArray(state.tabs))
      return undefined;
    if (state.tabId !== undefined && typeof state.tabId !== "string") return undefined;
    if (
      !state.tabs.every(
        (t) =>
          t &&
          typeof t.id === "string" &&
          typeof t.url === "string" &&
          typeof t.current === "boolean",
      )
    )
      return undefined;
    return state as BrowserState;
  } catch {
    return undefined;
  }
}
