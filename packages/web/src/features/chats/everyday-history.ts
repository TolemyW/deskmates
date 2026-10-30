// Use is a reading projection, never a rewrite of transcript or run status.
import { type ThreadMessage, isTerminal } from "@deskmates/contracts";
import type { RunView } from "../../api/types.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import type { ThreadViewState, TranscriptItem } from "../../state/thread-view.js";
import { approvalRefOf } from "../approvals/approval-card.js";
import { activityNotice } from "./activity-notice.js";
import { handoffPresentation } from "./handoff-message.js";

/**
 * A Gateway job (summary, review, memory) is not the person's work. A Guest's status inquiry is:
 * it is the only answer to their question, so its progress and failure stay visible in Use.
 */
export function isInternalJob(run: RunView): boolean {
  return Boolean(run.config.runType) && run.config.runType !== "status_inquiry";
}

export function currentFailure(run: RunView, state: ThreadViewState): boolean {
  if (!["failed", "stopped", "cancelled"].includes(run.status) || isInternalJob(run)) return false;
  const lastHuman = state.messages.filter((message) => message.authorKind === "human").at(-1);
  if (lastHuman && lastHuman.ts > run.createdAt) return false;
  return !Object.values(state.runs).some((next) => {
    if (next.botId !== run.botId || next.id === run.id || next.createdAt <= run.createdAt)
      return false;
    if (isInternalJob(next) || (isTerminal(next.status) && next.status !== "succeeded"))
      return false;
    const sameRound = run.roundMessageIds?.some((id) => next.roundMessageIds?.includes(id));
    return (
      sameRound || (run.triggerKind === next.triggerKind && run.triggerRef === next.triggerRef)
    );
  });
}

export function routingNoticeKey(message: ThreadMessage): MessageKey | undefined {
  if (message.authorKind !== "system") return undefined;
  if (/^No member replied to message #\d+:/.test(message.body)) return "chatPane.notice.noReply";
  if (/^.+ (?:is|are) paused and was not woken by message #\d+\./.test(message.body))
    return "chatPane.notice.paused";
  // The mention form (router) and the private-chat handoff form (direct messages).
  if (/^(?:@[^\s]+|.+'s handoff to .+) was not delivered:/.test(message.body))
    return "chatPane.notice.notDelivered";
  return undefined;
}

function showSystem(message: ThreadMessage, state: ThreadViewState): boolean {
  const ref = approvalRefOf(message.attachments);
  // Decisions remain as compact receipts; ChatApproval folds the request and audit trail.
  if (ref !== undefined) return true;
  if (routingNoticeKey(message)) {
    // Do not turn a current unanswered request into an apparently idle, empty chat.
    return !state.messages.some((next) => next.authorKind !== "system" && next.seq > message.seq);
  }
  if (activityNotice(message)) return true;
  const handoff = handoffPresentation(message);
  if (!handoff) return false;
  if (handoff.state === "returned") return Boolean(handoff.reply?.trim());
  if (handoff.state === "failed" || handoff.state === "stopped") {
    const run = message.runId ? state.runs[message.runId] : undefined;
    if (run) return currentFailure(run, state);
    return !state.messages.some((next) => next.authorKind === "human" && next.seq > message.seq);
  }
  return false;
}

export function everydayHistory(
  items: readonly TranscriptItem[],
  state: ThreadViewState,
  revealMessage?: string,
): TranscriptItem[] {
  return items.filter((item) => {
    if (item.kind === "elsewhere") return false;
    if (item.kind === "outcome") return currentFailure(item.run, state);
    return (
      item.message.authorKind !== "system" ||
      item.message.id === revealMessage ||
      showSystem(item.message, state)
    );
  });
}
