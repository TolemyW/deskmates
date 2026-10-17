// The "waking instruction" an approval card shows (ADR-0002 amendment 3, A4): the human message
// that started the work, found by walking the requesting run's wake chain past bot messages and
// past `system` notices that name a run. A notice is never the instruction, so cards never nest.

import type { MessageId, ThreadMessage } from "@deskmates/contracts";
import type { RunRecord } from "../ledger/runs.js";

const WAKE_CHAIN_MAX_HOPS = 8;

export interface InstructionSources {
  runs: { get(id: RunRecord["id"]): RunRecord | undefined };
  messages: { get(id: MessageId): ThreadMessage | undefined };
}

/**
 * The originating human message's body; without one, the bot message that woke the run; never a
 * `system` message. A cron or webhook run has none.
 */
export function cardInstruction(deps: InstructionSources, run: RunRecord): string | undefined {
  if (run.triggerKind !== "thread_message") return undefined;
  const direct = deps.messages.get(run.triggerRef as MessageId);
  let message = direct;
  for (let hop = 0; message && hop < WAKE_CHAIN_MAX_HOPS; hop += 1) {
    if (message.authorKind === "human") return message.body;
    if (message.runId === undefined) break;
    const upstream = deps.runs.get(message.runId);
    if (!upstream || upstream.triggerKind !== "thread_message") break;
    message = deps.messages.get(upstream.triggerRef as MessageId);
  }
  return direct?.authorKind === "bot" ? direct.body : undefined;
}
