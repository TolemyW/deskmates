// Welcome delivery (ADR-0024 amendment 2, decision 11; issue #122). A welcome run may greet
// through `thread_post` and still end `silent` (an empty final reply, ADR-0005 decision 3), so
// its status alone does not say whether the greeting reached the Bot's private chat. The
// Gateway's retry route and the Chats composer both decide with this one predicate.

import type { Run } from "./run.js";
import { isTerminal } from "./run.js";
import type { ThreadMessage } from "./thread.js";

/**
 * - `pending`: the welcome has not finished yet.
 * - `delivered`: the greeting is in the chat (a succeeded run, or a posted message).
 * - `partial`: the run ended failed, cancelled or stopped after posting a message; reported as
 *   such and not retried, because a greeting is already there.
 * - `undelivered`: the run ended without any greeting in its chat; the only retryable state.
 */
export type WelcomeDelivery = "pending" | "delivered" | "partial" | "undelivered";

/** The message fields the attribution reads; a `ThreadMessage` satisfies it. */
export type WelcomeMessage = Pick<ThreadMessage, "threadId" | "authorKind" | "authorId" | "runId">;

/**
 * Whether `message` is a greeting attributable to `run` in its own thread: bot-authored, by the
 * run's Bot, carrying the run's id. A post into another thread does not count.
 */
export function isWelcomeGreeting(
  run: Pick<Run, "id" | "botId" | "threadId">,
  message: WelcomeMessage,
): boolean {
  return (
    run.threadId !== undefined &&
    message.threadId === run.threadId &&
    message.authorKind === "bot" &&
    message.authorId === run.botId &&
    message.runId === run.id
  );
}

/** Where a welcome run stands; `posted` is whether a greeting attributable to it exists. */
export function welcomeDelivery(run: Pick<Run, "status">, posted: boolean): WelcomeDelivery {
  if (!isTerminal(run.status)) return "pending";
  if (run.status === "succeeded" || (run.status === "silent" && posted)) return "delivered";
  return posted ? "partial" : "undelivered";
}

/** Only an undelivered welcome may be started again (`POST /api/bots/:id/welcome`). */
export function canRetryWelcome(delivery: WelcomeDelivery): boolean {
  return delivery === "undelivered";
}
