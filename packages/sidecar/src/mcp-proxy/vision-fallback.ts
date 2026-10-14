// The opt-in vision fallback from design v0.3 section 3.3. It observes locator failures only;
// execution stays in the proxy so the screenshot crosses the same target, lock and takeover
// fences as every other browser observation. It never retries the failed action.

import type { BrowserCall } from "./browser-coordinator.js";

const TARGET_NOT_FOUND = /\bref\s+(\S+)\s+not found in the current page snapshot\b/i;
const REFRESH_TOOLS = new Set(["browser_snapshot", "browser_find", "browser_take_screenshot"]);

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const record = result as { content?: unknown; isError?: unknown };
  if (record.isError !== true || !Array.isArray(record.content)) return "";
  return record.content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return [];
      const value = block as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

/** Pinned MCP 0.0.82 names the selected ref `target`; `element` is optional. */
export function failedTargetKey(call: BrowserCall, result: unknown): string | undefined {
  const missing = TARGET_NOT_FOUND.exec(resultText(result));
  if (!missing) return undefined;
  const target = call.arguments.target;
  if (typeof target === "string" && target.trim() !== "")
    return missing[1] === target ? JSON.stringify([call.name, target]) : undefined;

  // Older MCP clients used `ref` together with a required semantic element. Their refs may
  // change across snapshots, so retain the original element-keyed behavior for those calls.
  const element = call.arguments.element;
  const ref = call.arguments.ref;
  if (
    typeof element !== "string" ||
    element.trim() === "" ||
    typeof ref !== "string" ||
    missing[1] !== ref
  )
    return undefined;
  return JSON.stringify([call.name, element.trim()]);
}

export class VisionFallbackTracker {
  private previousKey: string | undefined;
  private failures = 0;

  /** True only for the second consecutive lookup failure for the same semantic target. */
  observe(call: BrowserCall, result: unknown): boolean {
    const key = failedTargetKey(call, result);
    if (!key) {
      // Refreshing the model's observation is the expected step after a stale ref. It must not
      // erase the first failure, or the documented failure -> snapshot -> failure path can never
      // reach vision fallback.
      if (REFRESH_TOOLS.has(call.name)) return false;
      this.reset();
      return false;
    }
    if (key !== this.previousKey) {
      this.previousKey = key;
      this.failures = 1;
      return false;
    }
    this.failures += 1;
    if (this.failures !== 2) return false;
    return true;
  }

  reset(): void {
    this.previousKey = undefined;
    this.failures = 0;
  }
}
