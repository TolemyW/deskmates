// Screenshots in the ledger (test strategy §7; design v0.3 §3.2 "screenshots" in the event
// stream). The MCP stdio proxy (`mcp-proxy/`) takes one after every browser action that changes
// the page and writes it to a per-run directory before it forwards the action's result; the run
// process (`run-once.ts`) pairs the nth such action with file n and emits the `screenshot` event.
// Both sides count with `isPageChangingBrowserTool`, so this module is the contract between them.
//
// Caps. A viewport JPEG is tens of kilobytes; a full-page PNG would be the largest row in the
// ledger by far, so the proxy asks for a viewport-only JPEG, drops any capture above
// SCREENSHOT_MAX_BYTES, and stops capturing after SCREENSHOT_MAX_PER_RUN actions. The image is not
// redacted: the redactor works on text, and a rendered page can show a token in a form field.
// The README says so; the run screen renders it as a data URL built from `mimeType` + `base64`.

import { splitMcpToolName } from "./risk-tier.js";

/** Environment variable that tells the proxy where to write captures; unset means no captures. */
export const SCREENSHOT_DIR_ENV = "DESKMATES_SCREENSHOT_DIR";

/** Captures per run; after this many page-changing actions the proxy stops taking them. */
export const SCREENSHOT_MAX_PER_RUN = 40;

/** Largest capture kept, in bytes of the encoded image; larger ones are dropped, never resized. */
export const SCREENSHOT_MAX_BYTES = 300_000;

/** Longest the run process waits for the file of an action whose result it has already seen. */
export const SCREENSHOT_WAIT_MS = 2000;

export const SCREENSHOT_MIME = "image/jpeg";

/**
 * Browser tools after which the page can look different: navigation, clicks, typing, form fills,
 * selections, key presses, drag, dialog handling, uploads, tab switches. Read-only tools
 * (snapshot, screenshot, find, console, network, wait) never trigger a capture.
 */
const PAGE_CHANGING_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_drop",
  "browser_handle_dialog",
  "browser_file_upload",
  "browser_tabs",
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_run_code_unsafe",
  "browser_evaluate",
]);

/** Whether a tool call (bare or `mcp__browser__` name) can change what the page shows. */
export function isPageChangingBrowserTool(toolName: string): boolean {
  const { server, tool } = splitMcpToolName(toolName);
  if (server !== undefined && server !== "browser") return false;
  return PAGE_CHANGING_BROWSER_TOOLS.has(tool);
}

/** What the proxy writes for action `n`, as `<dir>/<n>.json`. */
export interface ScreenshotFile {
  /** 1-based count of page-changing browser actions in this MCP session. */
  action: number;
  /** Bare tool name of the action (`browser_click`). */
  toolName: string;
  mimeType: string;
  base64: string;
  /** Decoded size of the image. */
  bytes: number;
  takenAt: string;
  /** Stable CDP target, recorded by the coordinated browser runtime. */
  tabId?: string;
  browserEpoch?: number;
}

export function screenshotFileName(action: number): string {
  return `${action}.json`;
}

/** Parse a capture file; undefined when it is not one (partial write, wrong shape). */
export function parseScreenshotFile(text: string): ScreenshotFile | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const f = json as Partial<ScreenshotFile>;
  if (
    typeof f.action !== "number" ||
    typeof f.toolName !== "string" ||
    typeof f.mimeType !== "string" ||
    typeof f.base64 !== "string" ||
    typeof f.bytes !== "number" ||
    typeof f.takenAt !== "string"
  ) {
    return undefined;
  }
  return {
    action: f.action,
    toolName: f.toolName,
    mimeType: f.mimeType,
    base64: f.base64,
    bytes: f.bytes,
    takenAt: f.takenAt,
    ...(typeof f.tabId === "string" ? { tabId: f.tabId } : {}),
    ...(typeof f.browserEpoch === "number" ? { browserEpoch: f.browserEpoch } : {}),
  };
}
