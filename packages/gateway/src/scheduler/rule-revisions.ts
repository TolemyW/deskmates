// The numbered SOUL/MEMORY versions a run's attempt started with (ADR-0043 decision 2), and what
// that means for the SDK session it leaves behind.

import type { BotId } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

export interface RuleRevisions {
  /** `bot_rule_versions` number of the SOUL.md this attempt was given; null before any save. */
  canonicalSoulRevision: number | null;
  /** The same for the operator's MEMORY.md (learned memory is versioned on its own). */
  operatorMemoryRevision: number | null;
}

export function ruleRevisionsOf(ctx: GatewayContext, botId: BotId): RuleRevisions {
  return {
    canonicalSoulRevision: ctx.bots.versions.latestNumber(botId, "soul") ?? null,
    operatorMemoryRevision: ctx.bots.versions.latestNumber(botId, "memory") ?? null,
  };
}

/**
 * Whether SOUL or MEMORY was saved after this run's attempt started. A save clears the bot's SDK
 * sessions so the next run starts a fresh one under the new rules; a run that was live during the
 * save must not put its older session back when it ends (ADR-0043 decision 3). A run that recorded
 * no revisions (it never reached the sandbox) is not judged.
 */
export function rulesChangedSince(
  ctx: GatewayContext,
  botId: BotId,
  config: Readonly<Record<string, unknown>>,
): boolean {
  if (!("canonicalSoulRevision" in config) && !("operatorMemoryRevision" in config)) return false;
  const now = ruleRevisionsOf(ctx, botId);
  return (
    (config.canonicalSoulRevision ?? null) !== now.canonicalSoulRevision ||
    (config.operatorMemoryRevision ?? null) !== now.operatorMemoryRevision
  );
}
