// ADR-0005 item 5: a direct bot handoff is an ordinary, pairwise bus thread.
// The allowlist is routing configuration, not isolation between workspace peers.
import {
  DeskmatesError,
  type Run,
  THREAD_LINK_ATTACHMENT_MIME,
  type ThreadId,
  type ThreadMessage,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

export interface DirectMessageResult {
  message: ThreadMessage;
  handoff?: ThreadMessage;
  delivered?: boolean;
  reason?: string;
}

export function postDirectMessage(
  ctx: GatewayContext,
  run: Run,
  to: string,
  body: string,
  attachments: ThreadMessage["attachments"],
  sourceMessage?: ThreadMessage,
): DirectMessageResult {
  const caller = ctx.bots.mustGet(run.botId);
  const targetName = to.trim().toLowerCase();
  const target = ctx.bots.list(caller.workspaceId).find((b) => b.name.toLowerCase() === targetName);
  if (!target || target.id === caller.id) {
    throw new DeskmatesError("validation", "message_bot needs another bot in the same workspace", {
      to,
    });
  }
  if (!caller.messageAllowlist.some((name) => name.toLowerCase() === targetName)) {
    throw new DeskmatesError(
      "validation",
      "recipient is not configured in this bot's message allowlist",
      { to },
    );
  }
  if (run.threadId) {
    const source = ctx.threads.mustGet(run.threadId);
    // ADR-0005 amendment 5 decision 38: with no message-count bound only a pause refuses.
    const budget = source.kind === "chat" ? ctx.router.effectiveCaps(source.id).turnBudget : null;
    if (
      source.kind === "chat" &&
      (source.status === "paused" ||
        (budget !== null && ctx.messages.botCountSinceLastHuman(source.id) >= budget))
    ) {
      throw new DeskmatesError(
        "validation",
        "source conversation is paused or its turn budget was reached",
      );
    }
  }

  return ctx.bus.batch(() => {
    const result = ctx.db.transaction(() => {
      // A pair has one bus regardless of which member initiated the handoff. SQLite's
      // transaction serializes lookup/create; no route handler contains SQL.
      const existing = ctx.db
        .prepare(
          `SELECT t.id FROM threads t
       WHERE t.workspace_id = ? AND t.kind = 'bus'
         AND (SELECT count(*) FROM thread_members m WHERE m.thread_id = t.id) = 2
         AND EXISTS (SELECT 1 FROM thread_members m WHERE m.thread_id = t.id AND m.bot_id = ?)
         AND EXISTS (SELECT 1 FROM thread_members m WHERE m.thread_id = t.id AND m.bot_id = ?)
       ORDER BY t.created_at, t.id LIMIT 1`,
        )
        .get(caller.workspaceId, caller.id, target.id) as { id: string } | undefined;
      const thread = existing
        ? ctx.threads.mustGet(existing.id as ThreadId)
        : ctx.threads.create({
            workspaceId: caller.workspaceId,
            kind: "bus",
            botIds: [caller.id, target.id],
            channel: "internal",
          });
      const message = ctx.router.postFromRunToThread(run, thread.id, body, attachments, target.id);
      const recipientRun =
        message.relayCount <= ctx.router.effectiveCaps(thread.id).relayCountMax &&
        ctx.threads.mustGet(thread.id).status !== "paused"
          ? ctx.runs.findQueued(target.id, thread.id)
          : undefined;
      const result: DirectMessageResult = {
        message,
        delivered: recipientRun !== undefined,
        ...(!recipientRun
          ? { reason: "handoff conversation is paused or its conversation limit was reached" }
          : {}),
      };
      if (run.threadId && ctx.threads.mustGet(run.threadId).kind === "chat") {
        result.handoff = ctx.messages.append({
          threadId: run.threadId,
          authorKind: "system",
          authorId: "",
          runId: run.id,
          body: recipientRun
            ? `${caller.name} handed off to ${target.name}.`
            : `${caller.name}'s handoff to ${target.name} was not delivered: ${result.reason}.`,
          attachments: [
            {
              name: "Open conversation",
              mimeType: THREAD_LINK_ATTACHMENT_MIME,
              ref: thread.id,
            },
          ],
        });
      }
      // The handoff line is what the human sees of this run in the chat thread: for a member
      // being offered an unaddressed request, handing it off is taking it.
      if (result.handoff) ctx.router.handedOff(run);
      if (
        recipientRun &&
        result.handoff &&
        run.threadId &&
        ctx.threads.mustGet(run.threadId).channel === "web" &&
        ctx.threads.members(run.threadId).length === 1
      ) {
        const inbox = ctx.privateChats.record(
          message.id,
          sourceMessage?.id ?? result.handoff.id,
          target.id,
          recipientRun.id,
        );
        ctx.bus.publish({ type: "thread_activity", threadId: inbox });
      }
      ctx.events.append({
        runId: run.id,
        kind: "log",
        payload: { tool: "message_bot", threadId: thread.id, messageId: message.id, to: target.id },
      });
      return result;
    })();
    for (const message of [result.message, ...(result.handoff ? [result.handoff] : [])]) {
      ctx.bus.publish({ type: "thread_message", threadId: message.threadId, message });
    }
    return result;
  });
}
