// No self-approval (ADR-0002 amendment 3, A10). A bot that is a member of the request's thread
// may still decide it (amendment 2, A2), except when it is the bot that asked, or when the request
// came from a run it delegated. A bot decides `allow_once` or `deny` only; `allow_always` stores a
// rule (or, for an egress ask, grows the allowlist), and only humans do that.
//
// A deciding teammate stays a soft boundary, as A2 says: this removes the obvious rubber stamp,
// it does not make bots a security boundary.

import {
  type Approval,
  type ApprovalDecision,
  type BotId,
  DeskmatesError,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { type DelegationOutcomeDeps, wakeChain } from "../threads/delegation-outcomes.js";

/**
 * Throws `forbidden` when the deciding bot may not settle this approval with this decision.
 *
 * The delegation check reads the requesting run's wake chain (ADR-0016 amendment 1, decision 7):
 * a bot whose first appearance in it comes before the requesting bot's is upstream, so the request
 * came from work that bot handed down. A continuation request (ADR-0016 decision 3) is exempt from that
 * check: it is addressed to the delegator, who decides whether its delegate continues, and
 * amendment 3 A4 leaves decision 3 unchanged. The self check still applies to it.
 */
export function assertBotMayDecide(
  deps: Pick<DelegationOutcomeDeps, "runs" | "messages">,
  approval: Approval,
  decidingBotId: BotId,
  decision: ApprovalDecision,
): void {
  const details = { approvalId: approval.id, botId: decidingBotId, decision };
  if (decision === "allow_always") {
    throw new DeskmatesError(
      "forbidden",
      "a bot may decide allow_once or deny; only a human may answer Always",
      { ...details, refusal: "bot_allow_always" },
    );
  }
  if (approval.botId === decidingBotId) {
    throw new DeskmatesError("forbidden", "a bot may not decide a request its own run made", {
      ...details,
      refusal: "self_approval",
    });
  }
  if (approval.kind === "continuation") return;
  const requestingRun = deps.runs.get(approval.runId);
  if (!requestingRun) return;
  // First appearance decides who is upstream, as for delegations: a delegate that reported back
  // up the chain ("done @chief") appears after its delegator and is not upstream of it.
  const chain = wakeChain(deps, requestingRun);
  const decider = chain.indexOf(decidingBotId);
  if (decider !== -1 && decider < chain.indexOf(approval.botId)) {
    throw new DeskmatesError(
      "forbidden",
      "a bot may not decide a request that came from work it delegated",
      { ...details, refusal: "delegator_approval" },
    );
  }
}

/**
 * Issue #89: a bot's refused decision is said in the thread, as a decided one is. A live bot was
 * refused as a delegator and still told the thread the request was approved; the request stayed
 * pending and nobody reading the transcript could tell. The line wakes nobody, like the broker's
 * echo of a decision, and carries no approval attachment: the card has not changed.
 */
export function announceRefusedBotDecision(
  deps: Pick<GatewayContext, "messages" | "bus" | "bots">,
  approval: Approval,
  decidingBotId: BotId,
  decision: ApprovalDecision,
  error: DeskmatesError,
): void {
  if (!approval.threadId) return;
  const name = deps.bots.get(decidingBotId)?.name ?? decidingBotId;
  const verb = decision === "deny" ? "deny" : "approve";
  const message = deps.messages.append({
    threadId: approval.threadId,
    authorKind: "system",
    authorId: "",
    body: `Not recorded: ${name} tried to ${verb} ${approval.botId === decidingBotId ? "its own request" : "this request"}, but ${error.message}. The request is still waiting for a decision.`,
    relayCount: 0,
  });
  deps.bus.publish({ type: "thread_message", threadId: approval.threadId, message });
}
