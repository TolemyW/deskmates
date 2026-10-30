// ADR-0029 decision 12: a threadless cron round parked on a human still skips the next tick, as
// before, so nobody is asked twice; it no longer does so silently. The bot's private chat, which
// is where the operator UI shows the bot's threadless requests (ADR-0002 amendment 3, A9), gets a
// notice naming the parked round and what it waits for. The cron runner rate-limits the calls.

import type { BotDefinition } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";

export class ParkedCronNotices {
  constructor(private readonly ctx: GatewayContext) {}

  /** The request the parked round waits for, in words, with the approval id when there is one. */
  pendingRequest(run: RunRecord): string {
    const pending = this.ctx.approvals.pendingForRun(run.id)[0];
    if (pending) {
      const what =
        pending.kind === "continuation"
          ? "a continuation decision"
          : `approval of ${pending.action.toolName}`;
      return `${what} (approval ${pending.id})`;
    }
    return run.status === "waiting_browser" ? "the browser, which a human holds" : run.status;
  }

  skipped(
    bot: BotDefinition,
    parked: RunRecord,
    entry: number,
    schedule: string,
    minute: string,
  ): void {
    const chat = this.ctx.privateChats.existing(bot.id);
    if (!chat) return;
    const message = this.ctx.messages.append({
      threadId: chat.id,
      authorKind: "system",
      authorId: "",
      body: `Schedule ${entry + 1} (${schedule}) skipped its round at ${minute}: the previous round, run ${parked.id}, is still parked waiting for ${this.pendingRequest(parked)}. Later rounds are skipped until it is decided; this is said again at most once an hour.`,
      relayCount: 0,
    });
    this.ctx.bus.publish({ type: "thread_message", threadId: chat.id, message });
  }
}
