// ADR-0026 amendment 1: a paused bot's cron round is skipped, and its private chat says so once
// per entry and pause, so the operator sees why a schedule did not fire without one line a minute.

import type { BotDefinition } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

export class PausedCronNotices {
  /** `bot:pausedAt:entry` already noted by this process; a restart notes each once more. */
  private readonly noted = new Set<string>();

  constructor(private readonly ctx: GatewayContext) {}

  skipped(bot: BotDefinition, entry: number, schedule: string): void {
    const key = `${bot.id}:${bot.pausedAt ?? ""}:${entry}`;
    if (this.noted.has(key)) return;
    this.noted.add(key);
    const chat = this.ctx.privateChats.existing(bot.id);
    if (!chat) return;
    const message = this.ctx.messages.append({
      threadId: chat.id,
      authorKind: "system",
      authorId: "",
      body: `Schedule ${entry + 1} (${schedule}) did not run: ${bot.name} is paused. A paused bot skips its schedules until it is resumed.`,
      relayCount: 0,
    });
    this.ctx.bus.publish({ type: "thread_message", threadId: chat.id, message });
  }
}
