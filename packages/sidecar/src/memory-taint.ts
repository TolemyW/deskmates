// Run taint for learned memory (ADR-0011 decision 3). A run is tainted from the first model
// response whose input held untrusted content: a browser or connector result, a shell fetch, a
// webhook body, another bot's message, or an untrusted memory entry. Every learned item formed at
// or after that response is `untrusted`; the sidecar sets trust here and overrides whatever the
// model wrote in its summary.
//
// "Turn" is a model response, counted from 1 within this sidecar process, the same count
// `turn-usage.ts` uses. Content that arrives with the prompt taints turn 1; a tool result that
// answers response k taints turn k + 1, the first response that could have read it.
//
// Known limit: `LearnedItem.turn` is the model's own attribution, written in the final summary.
// A tainted model could backdate an item; the Gateway's confirmation gate (imperatives, duty
// subjects, contradictions with trusted entries) is the second line for exactly that case.

import {
  type DoNotLearnReason,
  type LearnedItem,
  type MemorySourceKind,
  type RunTaint,
  type TriggerPayload,
  UNTRUSTED_BOT_MARK_PREFIX,
} from "@deskmates/contracts";
import { BROWSER_MCP_SERVER, DESKMATES_MCP_SERVER } from "./risk-tier.js";
import { isShellFetch } from "./tool-action.js";
import { UNTRUSTED_MEMORY_MARK } from "./untrusted.js";

export const MEMORY_SEARCH_TOOL = `mcp__${DESKMATES_MCP_SERVER}__memory_search`;

/** Which source kind a tool's result counts as, or undefined when it does not taint. */
export function taintingToolSource(
  toolName: string,
  input: Record<string, unknown>,
): MemorySourceKind | undefined {
  if (toolName.startsWith(`mcp__${BROWSER_MCP_SERVER}__`)) return "page";
  if (toolName === `mcp__${DESKMATES_MCP_SERVER}__browser_cli_workflow`) return "page";
  // ADR-0048 decision 8: desktop UI text is untrusted like page text.
  if (toolName.startsWith("mcp__desktop__")) return "page";
  if (toolName.startsWith(`mcp__${DESKMATES_MCP_SERVER}__connector_`)) return "tool";
  if (toolName === "Bash" && typeof input.command === "string" && isShellFetch(input.command))
    return "page";
  return undefined;
}

/**
 * Untrusted content the trigger itself carries into the first response. A `system` message that
 * quotes another bot's reply (a delegation outcome notice for a `message_bot` handoff, ADR-0016
 * amendment 1 decision 9) carries the Gateway's bot wrapper and taints like the bot message would.
 */
export function triggerTaint(trigger: TriggerPayload): MemorySourceKind | undefined {
  if (trigger.kind === "webhook") return "webhook";
  if (
    trigger.kind === "thread_message" &&
    trigger.messages.some(
      (m) =>
        m.authorKind === "bot" ||
        (m.authorKind === "system" && m.body.includes(UNTRUSTED_BOT_MARK_PREFIX)),
    )
  )
    return "other_bot";
  return undefined;
}

interface PendingTaint {
  source: MemorySourceKind;
  /** Taint only when the result carries the untrusted-memory wrapper (`memory_search`). */
  wrappedOnly: boolean;
}

export class TaintTracker {
  private turns = 0;
  private readonly seen = new Set<string>();
  private taintedAt: number | undefined;
  private source: MemorySourceKind | undefined;
  private readonly pending = new Map<string, PendingTaint>();
  private readonly doNotLearnEvents: { turn: number; reason: DoNotLearnReason }[] = [];
  /** Wall-clock time of each response this process saw, for the items' `observedAt` (A9). */
  private readonly turnTimes: string[] = [];
  private readonly clock: () => Date;

  constructor(start: {
    trigger: TriggerPayload;
    sessionTainted?: boolean;
    sessionDoNotLearnReasons?: readonly DoNotLearnReason[];
    clock?: () => Date;
  }) {
    this.clock = start.clock ?? (() => new Date());
    // A resumed session already holds whatever tainted it in an earlier process.
    if (start.sessionTainted) this.taint(1, "tool");
    for (const reason of start.sessionDoNotLearnReasons ?? [])
      this.doNotLearnEvents.push({ turn: 1, reason });
    const fromTrigger = triggerTaint(start.trigger);
    if (fromTrigger) this.taint(1, fromTrigger);
  }

  /** One assistant message; a response split over several messages shares its id. */
  observeAssistant(messageId: string): void {
    if (this.seen.has(messageId)) return;
    this.seen.add(messageId);
    this.turns += 1;
    this.turnTimes.push(this.clock().toISOString());
  }

  observeToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    if (toolName === MEMORY_SEARCH_TOOL) {
      this.pending.set(toolUseId, { source: "tool", wrappedOnly: true });
      return;
    }
    const source = taintingToolSource(toolName, input);
    if (source) this.pending.set(toolUseId, { source, wrappedOnly: false });
  }

  /** A tool result entered the context; it is read by the next response. */
  observeToolResult(toolUseId: string, text: string): void {
    const pending = this.pending.get(toolUseId);
    if (pending === undefined) return;
    this.pending.delete(toolUseId);
    if (pending.wrappedOnly && !text.includes(UNTRUSTED_MEMORY_MARK)) return;
    this.taint(this.turns + 1, pending.source);
  }

  /** A transient failure reached the model before its next response; subsequent learning is unsafe. */
  markDoNotLearn(reason: DoNotLearnReason): void {
    this.doNotLearnEvents.push({ turn: this.turns + 1, reason });
  }

  /** How many responses this process has seen. */
  get turnCount(): number {
    return this.turns;
  }

  snapshot(): RunTaint {
    return {
      turns: this.turns,
      ...(this.taintedAt === undefined ? {} : { taintedAtTurn: this.taintedAt }),
      ...(this.source === undefined ? {} : { sourceKind: this.source }),
      ...(this.doNotLearnEvents.length === 0
        ? {}
        : { doNotLearnReasons: [...new Set(this.doNotLearnEvents.map((event) => event.reason))] }),
    };
  }

  /**
   * Stamp trust on the items a summary reported. A turn the model could not have been on (not a
   * positive integer, or past the last response) is read as the last response: an item nobody
   * can place is never more trusted than the run's end.
   */
  stamp(items: readonly LearnedItem[]): LearnedItem[] {
    const last = Math.max(1, this.turns);
    return items.map((item) => {
      const turn =
        Number.isInteger(item.turn) && item.turn >= 1 && item.turn <= last ? item.turn : last;
      const trusted = this.taintedAt === undefined || turn < this.taintedAt;
      return {
        body: item.body,
        proposedScope: item.proposedScope,
        authority: item.authority,
        turn,
        // ADR-0011 A9: the time of the turn the item names, set here and never by the model.
        observedAt: this.turnTimes[turn - 1] ?? this.clock().toISOString(),
        trust: trusted ? "trusted" : "untrusted",
        sourceKind: trusted ? "bot_self" : (this.source ?? "tool"),
        ...(this.doNotLearnEvents.some((event) => event.turn <= turn)
          ? {
              doNotLearnReasons: [
                ...new Set(
                  this.doNotLearnEvents
                    .filter((event) => event.turn <= turn)
                    .map((event) => event.reason),
                ),
              ],
            }
          : {}),
      };
    });
  }

  private taint(turn: number, source: MemorySourceKind): void {
    if (this.taintedAt !== undefined && this.taintedAt <= turn) return;
    this.taintedAt = turn;
    this.source = source;
  }
}
