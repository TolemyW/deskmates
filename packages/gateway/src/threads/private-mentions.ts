import { type Run, type ThreadMessage, mentionDiagnostics } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { postDirectMessage } from "./direct-messages.js";

/** Only the Gateway routes these addresses; a notification never routes a second request. */
export function routePrivateMentions(
  ctx: GatewayContext,
  run: Run,
  message: ThreadMessage,
  blocked?: string,
): void {
  const thread = ctx.threads.mustGet(message.threadId);
  const members = ctx.threads.members(thread.id);
  if (thread.kind !== "chat" || thread.channel !== "web" || members.length !== 1) return;
  if (message.mentions.some((mention) => mention.kind === "everyone")) return;
  const diagnostics = mentionDiagnostics(message.body, members, run.botId);
  const processed = new Set(ctx.privateChats.results(message.id).map((r) => r.name));
  const caller = ctx.bots.mustGet(run.botId);
  for (const name of diagnostics.unknown) {
    const key = name.toLowerCase();
    if (processed.has(key)) continue;
    processed.add(key);
    const target = ctx.threads.botByNameInWorkspace(thread.id, name);
    const reason =
      blocked ??
      (!target
        ? "no bot with this name exists in this workspace"
        : !caller.messageAllowlist.some((n) => n.toLowerCase() === key)
          ? "recipient is not configured in this bot's message allowlist"
          : undefined);
    if (reason) {
      ctx.privateChats.recordResult(message.id, key, null, reason);
      const notice = ctx.messages.append({
        threadId: thread.id,
        authorKind: "system",
        authorId: "",
        runId: run.id,
        body: `@${name} was not delivered: ${reason}.`,
        relayCount: 0,
      });
      ctx.bus.publish({ type: "thread_message", threadId: thread.id, message: notice });
    } else {
      // The bus message replaces this hop rather than adding another: both inherit the source run's relay.
      const result = postDirectMessage(ctx, run, name, message.body, message.attachments, message);
      ctx.privateChats.recordResult(
        message.id,
        key,
        result.delivered ? result.message.id : null,
        result.reason ?? null,
      );
    }
  }
}
