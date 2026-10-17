// Builds the `thread_message` trigger payload for a wake: the slice of the transcript the bot has
// not seen (`seq > last_seen_seq`), minus its own messages, labelled by author and capped by
// THREAD_PAYLOAD_MAX_TOKENS oldest-first (ADR-0005 item 2 and definitions).

import type {
  BotId,
  PostedMessageRouting,
  Thread,
  ThreadMessage,
  ThreadMessageDelivery,
  ThreadMessageTrigger,
  ThreadOffer,
  ThreadRoundBrief,
} from "@deskmates/contracts";

export interface Delivery {
  trigger: ThreadMessageTrigger;
  /** Highest seq in the unseen slice, including the bot's own messages; 0 when nothing is unseen. */
  deliveredSeq: number;
}

/**
 * What a group wake adds to the routing context (ADR-0005 amendment 2, decision 12): every
 * member in join order with its role, the current owner, and, when the wake is the offer of an
 * unaddressed request, who was offered it before. Facts the Gateway holds; nothing is inferred.
 */
export interface DeliveryGroup {
  members: ReadonlyArray<{ botId: BotId; name: string; role: string }>;
  ownerBotId?: BotId;
  offer?: ThreadOffer;
  /** Amendment 6 (`round-v1`): the plan of the round this wake works on or closes. */
  round?: ThreadRoundBrief;
  /** Amendment 6, decision 50: whom the recipient's previous final reply missed. */
  lastReply?: PostedMessageRouting;
}

/** Rough token estimate; the sidecar does the exact count, this only bounds the payload. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildDelivery(
  thread: Thread,
  botId: BotId,
  unseen: readonly ThreadMessage[],
  botNames: ReadonlyMap<string, string>,
  maxTokens: number,
  source?: ThreadMessage,
  group?: DeliveryGroup,
): Delivery {
  const deliveredSeq = unseen.reduce((max, m) => Math.max(max, m.seq), 0);
  const latestHumanSeq = unseen.reduce(
    (max, message) => (message.authorKind === "human" ? Math.max(max, message.seq) : max),
    0,
  );
  const relayCount = unseen
    .filter((message) => message.seq > latestHumanSeq)
    .filter((message) => !(message.authorKind === "bot" && message.authorId === botId))
    .reduce((max, message) => Math.max(max, message.relayCount), 0);
  const all: ThreadMessageDelivery[] = unseen
    .filter((m) => !(m.authorKind === "bot" && m.authorId === botId))
    .map((m) => ({
      seq: m.seq,
      authorKind: m.authorKind,
      authorId: m.authorId,
      authorName: labelFor(m, botNames),
      ...(m.authorKind === "system" ? {} : { addressing: addressingFor(m, botId) }),
      body: m.body,
      attachments: m.attachments,
    }));

  let budget = maxTokens;
  const kept: ThreadMessageDelivery[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i] as ThreadMessageDelivery;
    const cost = estimateTokens(m.body) + 8;
    if (kept.length > 0 && cost > budget) break;
    budget -= cost;
    kept.unshift(m);
  }
  const omitted = all.length - kept.length;
  if (omitted > 0) {
    kept.unshift({
      seq: 0,
      authorKind: "system",
      authorId: "",
      authorName: "system",
      body: `${omitted} earlier messages omitted`,
      attachments: [],
    });
  }
  return {
    trigger: {
      kind: "thread_message",
      thread: { id: thread.id, kind: thread.kind, title: thread.title },
      messages: kept,
      routing: {
        version: group ? 2 : 1,
        recipientBotId: botId,
        recipientName: botNames.get(botId) ?? botId,
        ...(source?.threadId === thread.id ? { sourceMessageSeq: source.seq } : {}),
        ...(group
          ? {
              members: group.members.map((member) => ({
                name: member.name,
                role: member.role,
                ...(member.botId === botId ? { you: true as const } : {}),
                ...(member.botId === group.ownerBotId ? { owner: true as const } : {}),
              })),
              ...(group.offer ? { offer: group.offer } : {}),
              ...(group.round ? { round: group.round } : {}),
              ...(group.lastReply ? { lastReply: group.lastReply } : {}),
            }
          : {}),
      },
      relayCount,
    },
    deliveredSeq,
  };
}

function labelFor(m: ThreadMessage, botNames: ReadonlyMap<string, string>): string {
  if (m.authorKind === "bot") return botNames.get(m.authorId) ?? m.authorId;
  if (m.authorKind === "system") return "system";
  return m.authorId || "human";
}

function addressingFor(
  m: ThreadMessage,
  botId: BotId,
): NonNullable<ThreadMessageDelivery["addressing"]> {
  if (m.mentions.some((mention) => mention.kind === "everyone")) return "everyone";
  if (m.mentions.some((mention) => mention.kind === "bot" && mention.botId === botId))
    return "recipient";
  return m.mentions.length > 0 ? "other" : "unaddressed";
}
