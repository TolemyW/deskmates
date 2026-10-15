// A triaged round as one card (ADR-0005 amendment 6, decision 51; proposed, `round-v1` only): who
// does what, each member's state, the closer and its state, the closer's synthesis as the main
// text and the members' own replies collapsed under it. It reads the durable round and its plan,
// like the round strip, and is presentation only: it never admits, blocks or orders work.

import type {
  GroupRouting,
  MessageId,
  RoundMemberState,
  RoundPlanPhase,
  RunStatus,
  ThreadRound,
} from "@deskmates/contracts";
import { formatTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { STATE_LABEL } from "./round-strip.js";

const PHASE_LABEL: Readonly<Record<RoundPlanPhase, MessageKey>> = {
  triage: "roundCard.phase.triage",
  working: "roundCard.phase.working",
  closing: "roundCard.phase.closing",
  closed: "roundCard.phase.closed",
  fallback: "roundCard.phase.fallback",
};

/** Whether the chat shows a round as a card: a planned round under `round-v1` only. */
export function showsRoundCard(
  routing: GroupRouting | undefined,
  round: ThreadRound | undefined,
): round is ThreadRound & { plan: NonNullable<ThreadRound["plan"]> } {
  return routing === "round-v1" && round?.plan !== undefined;
}

/** The closer's state, read from its one wake the way a member's is read from its runs. */
function closerState(status: RunStatus | undefined, synthesized: boolean): RoundMemberState {
  switch (status) {
    case undefined:
      return "pending";
    case "queued":
      return "queued";
    case "running":
    case "waiting_browser":
      return "running";
    case "waiting_approval":
    case "waiting_approval_live":
      return "awaiting_approval";
    case "waiting_continuation":
      return "paused";
    case "succeeded":
    case "silent":
      return synthesized ? "replied" : "silent";
    default:
      return status;
  }
}

export function RoundCard({
  round,
  botName,
  actorName,
  messageBody,
}: {
  round: ThreadRound & { plan: NonNullable<ThreadRound["plan"]> };
  botName: (botId: string) => string;
  actorName: (actor: string) => string;
  /** The body of a transcript message the chat has loaded, if it has. */
  messageBody: (id: MessageId) => string | undefined;
}) {
  const t = useT();
  const { plan } = round;
  const who = round.authorKind === "bot" ? botName(round.authorId) : actorName(round.authorId);
  const task = new Map(plan.assignments.map((a) => [a.botId as string, a.task]));
  const assigned = round.members.filter((m) => task.has(m.botId));
  const synthesis = plan.synthesisMessageIds
    .map((id) => messageBody(id))
    .filter((body): body is string => body !== undefined);
  const replies = assigned.flatMap((member) =>
    member.outputMessageIds.flatMap((id) => {
      const body = messageBody(id);
      return body === undefined ? [] : [{ id, botId: member.botId, body }];
    }),
  );
  const closer = plan.closerBotId;
  const closeState = closerState(plan.closerRunStatus, plan.synthesisMessageIds.length > 0);
  return (
    <section className="round-card" aria-label={t("roundCard.label")} data-testid="round-card">
      <p className="round-strip-head">
        <strong>{t("roundStrip.current")}</strong>
        {" · "}
        <span>{who}</span> <time dateTime={round.createdAt}>{formatTime(round.createdAt)}</time>
        <span className="round-strip-message">「{round.excerpt}」</span>
        <span className="round-strip-mode" data-testid="round-card-phase">
          {t(PHASE_LABEL[plan.phase])}
        </span>
        {round.cancelledAt ? <span className="muted"> · {t("roundStrip.cancelled")}</span> : null}
      </p>
      {plan.phase === "fallback" && plan.reason ? (
        <p className="muted small round-card-reason">
          {t("roundCard.fallbackReason", { reason: plan.reason })}
        </p>
      ) : null}
      {assigned.length > 0 ? (
        <ul className="round-card-assignments">
          {assigned.map((member) => (
            <li key={member.botId} className={`round-member ${member.state}`}>
              <span className="round-member-name">{botName(member.botId)}</span>
              <span className="round-card-task">{task.get(member.botId)}</span>
              <span className="round-member-state">{t(STATE_LABEL[member.state])}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {closer ? (
        <p className="round-card-closer small">
          {t("roundCard.closer", { name: botName(closer) })}{" "}
          {plan.closerRunId ? (
            <span className={`round-member ${closeState}`}>{t(STATE_LABEL[closeState])}</span>
          ) : null}
        </p>
      ) : null}
      {synthesis.length > 0 ? (
        <div className="round-card-synthesis" data-testid="round-card-synthesis">
          {synthesis.map((body, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one closer's messages, in order
            <p key={index}>{body}</p>
          ))}
        </div>
      ) : null}
      {replies.length > 0 ? (
        <details className="round-card-replies">
          <summary>{t("roundCard.replies", { count: replies.length })}</summary>
          <ul>
            {replies.map((reply) => (
              <li key={reply.id}>
                <span className="round-member-name">{botName(reply.botId)}</span>
                {": "}
                <span>{reply.body}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
