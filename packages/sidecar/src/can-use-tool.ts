// The `canUseTool` callback. The PreToolUse hook (hooks/pre-tool-use.ts) decides every call:
// allow, deny, or defer after the approval short wait. The SDK only reaches this callback when a
// tool needs permission and no hook gave a decision, which for the sidecar means the hook failed
// or timed out. There is no human on this path, so it fails closed and records why.

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { EventSink } from "./ledger.js";
import { riskTier } from "./risk-tier.js";
import type { RunState } from "./run-state.js";

export function createCanUseTool(sink: EventSink, state?: RunState): CanUseTool {
  return async (toolName, input, { toolUseID }) => {
    const riskLevel = riskTier(toolName, input);
    const message = `Blocked: ${toolName} reached the permission prompt without a hook decision`;
    // A refused call never reaches the MCP proxy; the run loop must not count it as an action.
    if (toolUseID !== undefined) state?.deniedToolUseIds.add(toolUseID);
    sink.emit("log", {
      source: "can_use_tool",
      toolUseId: toolUseID,
      toolName,
      riskLevel,
      decision: "deny",
      reason: message,
    });
    return { behavior: "deny", message };
  };
}
