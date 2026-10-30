// After a successful group kickoff, teammate names in the assistant's source-chat report are
// references. Remove only mentions that cannot be delivered there; valid routing is unchanged.
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";

export function assistantCreationReport(
  ctx: GatewayContext,
  run: RunRecord,
  reply: string,
): string {
  if (!run.threadId || run.config.workspaceAssistant !== "assistant-v1") return reply;
  const sourceMembers = ctx.threads.members(run.threadId);
  if (sourceMembers.length !== 1 || sourceMembers[0]?.botId !== run.botId) return reply;
  const allowed = new Set(
    ctx.bots.mustGet(run.botId).messageAllowlist.map((name) => name.toLowerCase()),
  );
  const references = new Set<string>();
  for (const message of ctx.messages.postedByRun(run.id)) {
    if (message.threadId === run.threadId || message.authorKind !== "bot") continue;
    const group = ctx.threads.mustGet(message.threadId);
    if (!group.externalKey?.startsWith(`assistant-group:${run.id}:`)) continue;
    for (const member of ctx.threads.members(group.id)) {
      if (member.botId !== run.botId && !allowed.has(member.name.toLowerCase()))
        references.add(member.name.toLowerCase());
    }
  }
  return reply.replace(/(^|[^\w@])@([\w-]+)/g, (whole: string, prefix: string, name: string) =>
    references.has(name.toLowerCase()) ? `${prefix}${name}` : whole,
  );
}
