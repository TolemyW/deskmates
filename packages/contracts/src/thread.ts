// Threads, members and messages (ADR-0005). The transcript belongs to the Gateway;
// each bot keeps its own SDK session per thread. Membership is routing, not access control.

import type { BotId, IsoTimestamp, MessageId, RunId, ThreadId, WorkspaceId } from "./ids.js";
import type { RunStatus } from "./run.js";

/** `chat` is created by a human and runs on the interactive lane; `bus` by `message_bot`, background lane. */
export type ThreadKind = "chat" | "bus";

export type ThreadStatus = "active" | "paused";

export type MessageAuthorKind = "human" | "bot" | "system";

/** Bot-authored messages since the last human message before the thread pauses (ADR-0005 item 6). */
export const TURN_BUDGET_DEFAULT = 8;

/** Maximum chain depth: a message posted from a run inherits the trigger's count plus one. */
export const RELAY_COUNT_MAX = 5;

/** A `chat` thread holds at most this many bots (ADR-0005 item 1). */
export const CHAT_THREAD_MAX_MEMBERS = 6;

/** A system handoff attachment; ref is a thread ID, never an external URL. */
export const THREAD_LINK_ATTACHMENT_MIME = "application/x-deskmates-thread";

/** Historical handoff messages retain their original MIME type in the ledger. */
export function isThreadLinkAttachmentMime(mimeType: string): boolean {
  return mimeType === THREAD_LINK_ATTACHMENT_MIME || mimeType === "application/x-cogbot-thread";
}

/**
 * How a message with no explicit recipient is routed in a group (ADR-0005 amendment 2).
 * `walk-v1` is decision 4 as first written: every member is woken in turn, for every unaddressed
 * message. `owner-v1` offers an unaddressed human message to one member at a time until one takes
 * it, records the taker as the thread's owner, and does not walk unaddressed bot messages.
 */
export type GroupRouting = "walk-v1" | "owner-v1";

export const GROUP_ROUTINGS: readonly GroupRouting[] = ["walk-v1", "owner-v1"];

export function isGroupRouting(value: unknown): value is GroupRouting {
  return typeof value === "string" && (GROUP_ROUTINGS as readonly string[]).includes(value);
}

export interface Thread {
  id: ThreadId;
  workspaceId: WorkspaceId;
  kind: ThreadKind;
  /** Channel that owns this thread when mapped externally (ADR-0017); `web` for the operator UI. */
  channel: string;
  /**
   * The channel adapter's id for the external conversation this thread is bound to (ADR-0017
   * decision 2); unique per channel. Absent for the operator UI's own threads.
   */
  externalKey?: string;
  title: string;
  turnBudget: number;
  status: ThreadStatus;
  /**
   * The member that took the latest unaddressed human request (ADR-0005 amendment 2, decision
   * 15). A routing fact and an accountability label, never access control: it decides who is
   * offered the next unaddressed message first, nothing else.
   */
  ownerBotId?: BotId;
  /**
   * When the thread's work must be done (issue #21). Once it has passed, the scheduler cancels
   * the thread's unfinished runs and starts no new one; messages are still stored.
   */
  deadline?: IsoTimestamp;
  /**
   * Set when a Member or Guest (or a `member` service principal) opened this thread as their own
   * chat with one bot: their actor label, `user:<id>` or `service:<id>` (ADR-0022 amendment 1).
   */
  sideChatActor?: string;
  /**
   * The person who alone reads this chat (ADR-0022 amendment 6 W7, ADR-0031 decision 9). Only
   * that person ever receives a thread that carries it; absent on shared threads.
   */
  privateToUserId?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Whether a thread is a person's private chat (ADR-0022 amendment 6 W7). */
export function isPrivateChat(thread: Pick<Thread, "privateToUserId">): boolean {
  return thread.privateToUserId !== undefined;
}

/**
 * Whether `actor` may post in `thread` as a Member (ADR-0022 amendment 1): a one-bot `chat`
 * they opened as a side chat. `memberCount` is the thread's current number of bot members.
 */
export function isOwnSideChat(
  thread: Pick<Thread, "kind" | "sideChatActor">,
  memberCount: number,
  actor: string,
): boolean {
  return thread.kind === "chat" && memberCount === 1 && thread.sideChatActor === actor;
}

/** Whether the thread's deadline, if it has one, is at or before `now`. */
export function isPastDeadline(thread: Pick<Thread, "deadline">, now: Date = new Date()): boolean {
  if (thread.deadline === undefined) return false;
  const at = Date.parse(thread.deadline);
  return !Number.isNaN(at) && at <= now.getTime();
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A deadline as the API takes it: an ISO 8601 date-time with a zone, returned in the canonical
 * UTC form the Gateway stores (so stored values compare as strings). Undefined when invalid.
 */
export function normalizeDeadline(value: string): IsoTimestamp | undefined {
  if (!ISO_TIMESTAMP.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

export interface ThreadMember {
  threadId: ThreadId;
  botId: BotId;
  /** Highest message `seq` delivered to this bot; 0 for a new member so its first wake gets everything. */
  lastSeenSeq: number;
  joinedAt: IsoTimestamp;
}

/** Operator SSE notification to refresh a thread's membership after a committed change. */
export interface ThreadMembersEvent {
  type: "thread_members";
  threadId: ThreadId;
}

export interface ThreadActivityEvent {
  type: "thread_activity";
  threadId: ThreadId;
}

/** Workspace-shared chat-rail pins changed; clients reload their authoritative ordered list. */
export interface ThreadPinsEvent {
  type: "thread_pins";
  workspaceId: WorkspaceId;
}

export interface Attachment {
  name: string;
  mimeType: string;
  /** Path inside the workspace filesystem or a Gateway artifact URL. */
  ref: string;
}

/** A parsed mention. `everyone` wakes every member in turn; otherwise a specific member. */
export type Mention = { kind: "everyone" } | { kind: "bot"; botId: BotId };

export interface ThreadMessage {
  id: MessageId;
  threadId: ThreadId;
  /** Monotonic within the thread, starting at 1. */
  seq: number;
  authorKind: MessageAuthorKind;
  /** Bot id for `bot`, operator identity for `human`, empty for `system`. */
  authorId: string;
  body: string;
  attachments: readonly Attachment[];
  mentions: readonly Mention[];
  /** 0 for human messages; a message posted from a run inherits the trigger's count plus one. */
  relayCount: number;
  /** The run that posted this message, for bot-authored messages (ADR-0005 item 10). */
  runId?: RunId;
  /**
   * The channel adapter's id for the external message this one came from (ADR-0017 decision 2);
   * unique per thread, so a redelivery returns this row instead of creating another.
   */
  externalId?: string;
  /**
   * The poster asked for a definite answer (issue #21). A run woken by this message that ends
   * `silent` is recorded `failed` with reason `no_reply`. Present only when set; routing ignores it.
   */
  mustReply?: true;
  ts: IsoTimestamp;
}

/** Message slice delivered to a bot as the payload of a `thread_message` wake. */
/** The newest message of a thread, as the chat list shows it: who, when, and an excerpt. */
export interface ThreadLastMessage {
  seq: number;
  authorKind: MessageAuthorKind;
  authorId: string;
  /** The first 160 characters of the body; the full text is on the message itself. */
  excerpt: string;
  ts: IsoTimestamp;
}

/**
 * A thread as `GET /api/threads` returns it: the row plus what a chat list needs at a glance.
 * `memberIds` lets a client open a bot's private chat without fetching every thread's detail.
 */
export interface ThreadSummary extends Thread {
  memberIds: readonly BotId[];
  /** Workspace-shared presentation order; absent when this thread is not pinned. */
  pinPosition?: number;
  /**
   * Present when the Gateway has bound this thread as that bot's canonical private chat
   * (ADR-0024 decision 6). Absent for older one-member chats, groups and bus threads; a client
   * never infers it from the member count.
   */
  privateChatBotId?: BotId;
  /** Unread incoming-work reminders for the authenticated operator, outside the transcript. */
  unreadHandoffs?: number;
  lastHandoff?: Pick<IncomingHandoff, "callerName" | "excerpt" | "createdAt">;
  lastMessage?: ThreadLastMessage;
}

export interface ThreadMessageDelivery {
  seq: number;
  authorKind: MessageAuthorKind;
  authorId: string;
  /** Display name for the author, resolved by the Gateway so the sidecar can label the turn. */
  authorName: string;
  /** Gateway-parsed routing, never inferred by the sidecar from message text. */
  addressing?: "recipient" | "everyone" | "unaddressed" | "other";
  body: string;
  attachments: readonly Attachment[];
}

/** One line of the roster a group wake carries (ADR-0005 amendment 2, decision 12). */
export interface RosterMember {
  name: string;
  /** The bot's `role` as its operator wrote it. */
  role: string;
  /** The recipient of this wake. */
  you?: true;
  /** The thread's current owner. */
  owner?: true;
}

/**
 * Present when the wake is the offer of an unaddressed human message (decision 14): who was
 * offered it before this member and ended without taking it, and who has not been offered yet.
 */
export interface ThreadOffer {
  messageSeq: number;
  passed: readonly string[];
  remaining: readonly string[];
}

/** The `thread_message` trigger payload (ADR-0005 "Sidecar contract"). */
export interface ThreadMessageTrigger {
  kind: "thread_message";
  thread: Pick<Thread, "id" | "kind" | "title">;
  messages: readonly ThreadMessageDelivery[];
  /** Optional for older Gateways. Routing facts confer no authority on message content. */
  routing?: {
    /** 2 when the wake carries a roster (`members`); 1 otherwise. */
    version: 1 | 2;
    recipientBotId: BotId;
    recipientName: string;
    sourceMessageSeq?: number;
    /** Every member in join order. Routing facts, like the recipient label. */
    members?: readonly RosterMember[];
    offer?: ThreadOffer;
  };
  relayCount: number;
}

/** Lane follows the thread kind, not who posted (ADR-0005 item 7). */
export function laneForThread(kind: ThreadKind): "interactive" | "background" {
  return kind === "chat" ? "interactive" : "background";
}

const MENTION_PATTERN = /(^|[^\w@])@([\w-]+)/g;

/**
 * Parse `@name` mentions against a member list. Unknown names and self-mentions are ignored;
 * `@everyone` yields a single `everyone` mention and drops the rest (ADR-0005 item 3, 4).
 */
export function parseMentions(
  body: string,
  members: ReadonlyArray<{ botId: BotId; name: string }>,
  authorBotId?: BotId,
): Mention[] {
  const byName = new Map<string, BotId>();
  for (const m of members) byName.set(m.name.toLowerCase(), m.botId);

  const seen = new Set<BotId>();
  const out: Mention[] = [];
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = (match[2] ?? "").toLowerCase();
    if (name === "everyone") return [{ kind: "everyone" }];
    const botId = byName.get(name);
    if (botId === undefined || botId === authorBotId || seen.has(botId)) continue;
    seen.add(botId);
    out.push({ kind: "bot", botId });
  }
  return out;
}

const SPACED_MENTION_PATTERN = /(^|[^\w@])@ +([\w-]+)/g;

/**
 * What a message looks like it meant to address and did not (ADR-0005 amendment 2): `@names`
 * that match no member, and member names written as `@ name`, with a space, which the parser
 * above does not read as a mention. Facts for whoever posted the message, so a hand-off that
 * wakes nobody is noticed where it was written; nothing here changes who is woken.
 */
export function mentionDiagnostics(
  body: string,
  members: ReadonlyArray<{ botId: BotId; name: string }>,
  authorBotId?: BotId,
): { unknown: string[]; spaced: string[] } {
  const byName = new Map<string, { botId: BotId; name: string }>();
  for (const m of members) byName.set(m.name.toLowerCase(), m);
  const unknown = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[2] ?? "";
    if (name.toLowerCase() === "everyone" || byName.has(name.toLowerCase())) continue;
    unknown.add(name);
  }
  const spaced = new Set<string>();
  for (const match of body.matchAll(SPACED_MENTION_PATTERN)) {
    const member = byName.get((match[2] ?? "").toLowerCase());
    if (member && member.botId !== authorBotId) spaced.add(member.name);
  }
  return { unknown: [...unknown], spaced: [...spaced] };
}

/**
 * What the Gateway answers a `thread_post` with: where the message sits and whom it addressed.
 * The sidecar relays it to the model as the tool's result and computes none of it.
 */
export interface PostedMessageRouting {
  seq: number;
  /** Names of the members the message mentions. */
  addressed: readonly string[];
  everyone: boolean;
  unknown: readonly string[];
  spaced: readonly string[];
  handoffs?: readonly { name: string; delivered: boolean; reason?: string }[];
  /**
   * Set when the message mentions someone and the Gateway created no run for it, so the mention
   * woke nobody (issue #68). The message itself is stored either way.
   */
  wakeBlocked?: WakeBlockedReason;
}

/**
 * Why a bot's post started no run. `relay_count` and `turn_budget` are the cap names a
 * `cap_breached` event carries; `thread_paused` and `deadline_passed` are the other two states
 * that start no run (issue #21).
 */
export type WakeBlockedReason = "relay_count" | "turn_budget" | "thread_paused" | "deadline_passed";

/** Operator activity only: never included in a bot's message delivery. */
export interface IncomingHandoff {
  seq: number;
  callerName: string;
  excerpt: string;
  sourceThreadId: ThreadId;
  sourceMessageId: MessageId;
  handoffThreadId: ThreadId;
  runId: RunId;
  status: RunStatus;
  createdAt: IsoTimestamp;
  unread: boolean;
}
