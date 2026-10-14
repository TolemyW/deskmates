// Durable request rounds (ADR-0005 amendment 4). A round is one accepted originating message,
// the members it targets and the runs related to each. Routing never reads it; the chat's
// current-round strip and Activity (ADR-0033) do.

import type { BotId, MessageId, RunId, ThreadId, WorkspaceId } from "./ids.js";

/** Decision 28: parallel; decision 29: an explicit one-by-one walk; amendment 2's offer. */
export type RoundMode = "parallel" | "sequential" | "offer";

export const ROUND_MODES: readonly RoundMode[] = ["parallel", "sequential", "offer"];

/** What a human chooses per message in the composer; only meaningful with `@everyone`. */
export type RequestedRoundMode = "parallel" | "sequential";

export function isRequestedRoundMode(value: unknown): value is RequestedRoundMode {
  return value === "parallel" || value === "sequential";
}

/** How a run came to serve a round member (decision 31, 35). */
export type RoundRunRelation = "created" | "coalesced" | "retry";

/** Decision 33: derived from the member's latest related run, never stored. */
export type RoundMemberState =
  | "pending"
  | "queued"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "replied"
  | "silent"
  | "failed"
  | "cancelled"
  | "stopped"
  | "seen"
  | "skipped"
  | "removed";

const DONE: ReadonlySet<RoundMemberState> = new Set([
  "replied",
  "silent",
  "failed",
  "cancelled",
  "stopped",
  "seen",
  "skipped",
  "removed",
]);

/** A member state that counts toward a round's `n/m` complete. */
export function isRoundMemberDone(state: RoundMemberState): boolean {
  return DONE.has(state);
}

export interface RoundRunRef {
  runId: RunId;
  relation: RoundRunRelation;
}

export interface RoundMember {
  botId: BotId;
  ordinal: number;
  state: RoundMemberState;
  /** The latest related run, which the state is derived from. */
  runId?: RunId;
  /** Every related run, oldest first. */
  runs: RoundRunRef[];
  /** Bot messages the related runs posted in the thread after the round's message. */
  outputMessageIds: MessageId[];
}

/**
 * A round is keyed by its originating message (decision 30): a redelivery cannot make a second
 * one, and its id in the API is that message's id.
 */
export interface ThreadRound {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  messageId: MessageId;
  messageSeq: number;
  authorKind: "human" | "bot";
  authorId: string;
  /** The message text, shortened for display; the transcript has the whole message. */
  excerpt: string;
  mode: RoundMode;
  /** The originating message of the parent round (a nested consultation). */
  parentMessageId?: MessageId;
  createdAt: string;
  cancelledAt?: string;
  members: RoundMember[];
  completed: number;
  total: number;
}
