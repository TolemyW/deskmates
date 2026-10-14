// What `thread_post` tells the model after a post (ADR-0005 amendment 2): where the message
// sits and whom it addressed, as the Gateway parsed it. A hand-off that mentions nobody wakes
// nobody, and the place to notice that is the tool result of the call that made it; a real model
// wrote "@ g_stock" with a space, ended its run, and the request stopped there. The sidecar
// computes none of this: it words the Gateway's facts.

import type { PostedMessageRouting, WakeBlockedReason } from "@deskmates/contracts";

// The Gateway's reason, worded for the run that posted (issue #68).
const WAKE_BLOCKED: Record<WakeBlockedReason, string> = {
  relay_count: "the thread's relay cap was reached",
  turn_budget: "the thread reached its turn budget and is paused until a human messages it",
  thread_paused: "the thread is paused until a human messages it",
  deadline_passed: "the thread is past its deadline",
};

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
  return parts.join(" ");
}
