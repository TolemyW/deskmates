// What `thread_post` tells the model after a post (ADR-0005 amendment 2): where the message
// sits and whom it addressed, as the Gateway parsed it. A hand-off that mentions nobody wakes
// nobody, and the place to notice that is the tool result of the call that made it; a real model
// wrote "@ g_stock" with a space, ended its run, and the request stopped there. The sidecar
// computes none of this: it words the Gateway's facts.

import type {
  PostedMessageRouting,
  ThreadPauseState,
  WakeBlockedReason,
} from "@deskmates/contracts";

// The Gateway's reason, worded for the run that posted (issue #68).
const WAKE_BLOCKED: Record<WakeBlockedReason, string> = {
  // Issue #90: a live lead was told this, mentioned the same bot twice more and declared the work
  // signed off. The count restarts after a person's message, so that is the way on.
  relay_count:
    "the thread's relay cap was reached, so bots cannot wake each other here until a person posts. Mentioning them again wakes nobody; if their part is still needed, say so to the people in this thread and do not report it as done",
  turn_budget: "the thread reached its turn budget and is paused",
  thread_paused: "the thread is paused",
  deadline_passed: "the thread is past its deadline",
};

/**
 * ADR-0005 amendment 3, decision 27: the Gateway's pause facts, worded for a run. A turn-budget
 * pause ends by itself at its resume time (rewritten decision 22); an operator pause only when a
 * person resumes it.
 */
export function describePause(paused: ThreadPauseState): string {
  if (paused.reason === "operator")
    return "The thread is paused by an operator: your posts are stored and wake nobody until a person resumes it.";
  return `The thread is paused because it reached its turn budget: your posts are stored and wake nobody until it resumes${
    paused.resumeAt ? ` by itself at ${paused.resumeAt}` : ""
  }, or earlier when a human writes or resumes it.`;
}

/**
 * ADR-0005 amendment 6, decision 50: the Gateway's facts about the recipient's previous final
 * reply in this thread, worded like the `thread_post` answer. A final reply is posted after the
 * run ends, so the next wake is the first place the bot can learn that an address missed.
 */
export function describeLastReply(routing: PostedMessageRouting): string {
  const missed = routing.unknown.map((name) => `@${name}`).join(", ");
  const addressed = routing.everyone
    ? "It was addressed to everyone."
    : routing.addressed.length > 0
      ? `It was addressed to ${routing.addressed.join(", ")}.`
      : "It mentioned no member, so it woke nobody.";
  return `Your final reply in your previous run was posted as message #${routing.seq}. ${addressed} No member of this thread is called ${missed}, so that address reached nobody; if someone has to act, post again with @ and a member's exact name.`;
}

export function describePosted(
  routing: PostedMessageRouting | undefined,
  ownerRouting: boolean,
): string {
  // An older Gateway sends no routing facts.
  if (!routing) return "Posted to the thread.";
  const parts = [`Posted as message #${routing.seq}.`];
  if (routing.everyone) {
    parts.push("It is addressed to everyone.");
  } else if (routing.addressed.length > 0) {
    parts.push(`It is addressed to ${routing.addressed.join(", ")}.`);
  } else if (!routing.handoffs?.some((h) => h.delivered)) {
    parts.push(
      ownerRouting
        ? "It mentions no member, so it wakes nobody; the others read it with their next wake."
        : "It mentions no member.",
    );
  }
  if (routing.wakeBlocked) {
    const reason = WAKE_BLOCKED[routing.wakeBlocked];
    if (!routing.everyone && routing.addressed.length === 1) {
      parts.push(`@${routing.addressed[0]} was not woken: ${reason}.`);
    } else if (!routing.everyone && routing.addressed.length > 1) {
      parts.push(
        `${routing.addressed.map((name) => `@${name}`).join(", ")} were not woken: ${reason}.`,
      );
    } else {
      parts.push(`Nobody was woken: ${reason}.`);
    }
  }
  for (const handoff of routing.handoffs ?? []) {
    parts.push(
      handoff.delivered
        ? `Handed off to @${handoff.name} in a separate conversation.`
        : `@${handoff.name} was not delivered: ${handoff.reason ?? "routing refused the handoff"}.`,
    );
  }
  for (const name of routing.spaced) {
    parts.push(
      `"@ ${name}" is not a mention: post again with @${name}, no space, if ${name} has to act.`,
    );
  }
  if (routing.unknown.length > 0) {
    parts.push(
      `No member of this thread is called ${routing.unknown.map((name) => `@${name}`).join(", ")}.`,
    );
  }
  if (routing.paused) {
    if (!routing.wakeBlocked) parts.push("Nobody was woken.");
    parts.push(describePause(routing.paused));
  }
  return parts.join(" ");
}
