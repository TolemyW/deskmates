// Native desktop tools (ADR-0048): LCU fronting an installed desktop application's
// computer-use runtime, registered by the sidecar behind its own `desktop-proxy`. On by default on
// an image that declares the capability, off on any other; an Owner or Admin may turn them off
// per workspace and per bot (decision 1 as rewritten by amendment 1, A1). Desktop calls are
// allowed without per-call approval (decision 2); their effect labels are recorded on the
// `tool_call` event, never used as a tier, and choose the shared-screen lease mode (A3).

import type { RunId } from "./ids.js";

/** The one desktop tool surface there is; frozen on the run row as `desktopTools`. */
export type DesktopToolsMode = "lcu-v1";

/** What `runs.config_json.desktopTools` holds: the mode, or `off`. */
export type DesktopToolsConfig = DesktopToolsMode | "off";

/** The image capability that makes `lcu-v1` available (decision 11). */
export const DESKTOP_LCU_CAPABILITY = "desktop-lcu-v1";

/** Image label listing capabilities, comma-separated; the Gateway reads it before enabling. */
export const IMAGE_CAPABILITIES_LABEL = "org.deskmates.capabilities";
/** Image labels naming the pinned versions; recorded on the setting and frozen on each run. */
export const DESKTOP_LCU_VERSION_LABEL = "org.deskmates.desktop.lcu-version";
export const DESKTOP_APP_VERSION_LABEL = "org.deskmates.desktop.app-version";

/** The MCP server name; the model sees `mcp__desktop__js` and `mcp__desktop__js_reset`. */
export const DESKTOP_MCP_SERVER = "desktop";

/** LCU's model-visible tools (ADR-0048 decision 3); every other tool of LCU is host-only. */
export const DESKTOP_MODEL_TOOLS: readonly string[] = ["js", "js_reset"];

/**
 * Effect labels of a desktop `js` body (decision 2). A label records what the code names; it
 * decides no tier and is not a security boundary.
 */
export type DesktopEffect =
  | "a11y"
  | "browser"
  | "capture"
  | "clipboard"
  | "file"
  | "input"
  | "launch"
  | "network"
  | "opaque"
  | "read"
  | `input ${string}`;

/** The capabilities an image's labels declare. */
export function imageCapabilities(labels: Readonly<Record<string, string>>): string[] {
  const raw = labels[IMAGE_CAPABILITIES_LABEL] ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** What a workspace image says about desktop tools, read from its labels. */
export interface DesktopImageFacts {
  capable: boolean;
  lcuVersion?: string;
  appVersion?: string;
}

export function desktopImageFacts(labels: Readonly<Record<string, string>>): DesktopImageFacts {
  const lcuVersion = labels[DESKTOP_LCU_VERSION_LABEL];
  const appVersion = labels[DESKTOP_APP_VERSION_LABEL];
  return {
    capable: imageCapabilities(labels).includes(DESKTOP_LCU_CAPABILITY),
    ...(lcuVersion ? { lcuVersion } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
}

/**
 * `GET /api/workspaces/:id/desktop-tools`. `image` is what the configured workspace image says
 * now; `unknown` when the sandbox provider cannot read image labels. `groupingException` is true
 * whenever the tools are enabled: the workspace may hold a signed-in account and browse untrusted
 * sites (decision 10), and the workspace page says so.
 */
export interface DesktopToolsView {
  workspaceId: string;
  /** Whether the workspace's bots get the tools now: the setting applied to the image. */
  enabled: boolean;
  /** `default` when no Owner or Admin chose: on exactly when the image is capable (A1). */
  setting: "default" | "on" | "off";
  mode?: DesktopToolsMode;
  /** The versions the image declared when the workspace was enabled. */
  lcuVersion?: string;
  appVersion?: string;
  image: "capable" | "not_capable" | "unknown";
  /** Bots of the workspace and whether each has the tools; only meaningful while enabled. */
  bots: { botId: string; name: string; enabled: boolean; setting: "default" | "on" | "off" }[];
  groupingException: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/** `PUT /api/workspaces/:id/desktop-tools`: an absent field is unchanged. */
export interface DesktopToolsInput {
  enabled?: boolean;
  /** Bot id to on or off. A bot can be turned on only in an enabled workspace. */
  bots?: Record<string, boolean>;
}

/**
 * The shared-screen lease of a desktop call (amendment 1, A3): `shared` for focus-free calls
 * (accessibility reads and actions, captures, `js_reset`), `exclusive` for raw pointer or key
 * input, focus changes and anything the scan cannot place. A soft distinction, not a boundary.
 */
export type DesktopLeaseMode = "exclusive" | "shared";

/**
 * Sidecar → Gateway (`POST /internal/runs/:runId/desktop-lock`). `probe` only asks whether a
 * human holds the workspace (the hook's check); the others name the call's lease by `callId`.
 */
export interface DesktopLockRequest {
  type: "desktop_lock";
  runId: RunId;
  op: "acquire" | "probe" | "release" | "renew";
  callId?: string;
  mode?: DesktopLeaseMode;
}

export interface DesktopLockResponse {
  type: "desktop_lock_result";
  runId: RunId;
  granted: boolean;
  /** The workspace's takeover epoch (ADR-0008); a change mid-call interrupts it. */
  epoch?: number;
  waitMessage?: string;
  /** Another call holds or waits for the screen; retrying shortly may succeed. */
  contended?: boolean;
}

/** What a desktop call waiting on another bot's raw input is told when its wait runs out. */
export const DESKTOP_SCREEN_BUSY_MESSAGE =
  "Another bot is sending keyboard or pointer input to the shared desktop. Nothing was sent; retry after it finishes, and prefer accessibility actions, which do not wait for the whole screen.";

/** What a browser call is told while a desktop call holds the screen for raw input. */
export const DESKTOP_INPUT_BLOCKS_BROWSER_MESSAGE =
  "A bot is sending keyboard or pointer input to the shared desktop. Wait a moment and retry the browser action.";
