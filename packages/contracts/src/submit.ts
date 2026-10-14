// Composite submit (issue #21, part 4): an external agent hands Deskmates one unit of work in one
// call. `POST /api/workspaces/:id/submit` creates a one-member `chat` thread bound to
// `(channel, externalKey)`, a task linked to it, and the instruction as a must-reply human
// message that wakes the bot through the normal router. The channel is derived from the caller,
// never named by it, so two clients' keys never collide. A second submit with the same key
// returns the existing ids and creates nothing; `GET /api/workspaces/:id/submissions` finds them
// again for a client that lost its response.

import type { BotId, IsoTimestamp, MessageId, ThreadId } from "./ids.js";
import type { Run } from "./run.js";
import type { Task, TaskOutputSchema } from "./task.js";
import type { Attachment, Thread } from "./thread.js";

/** Every submit channel starts with this; ordinary channel names cannot contain the colon. */
export const AGENT_CHANNEL_PREFIX = "agent:";

/** Who submits, as far as the channel name is concerned. */
export type AgentChannelCaller =
  | { kind: "service"; servicePrincipalId: string }
  | { kind: "user"; userId: string }
  | { kind: "operator" };

/**
 * The channel a caller's submissions are bound under: `agent:<service principal id>`,
 * `agent:user:<user id>`, or `agent:operator` for the shared operator credential.
 */
export function agentChannel(caller: AgentChannelCaller): string {
  switch (caller.kind) {
    case "service":
      return `${AGENT_CHANNEL_PREFIX}${caller.servicePrincipalId}`;
    case "user":
      return `${AGENT_CHANNEL_PREFIX}user:${caller.userId}`;
    case "operator":
      return `${AGENT_CHANNEL_PREFIX}operator`;
  }
}

/** Body of `POST /api/workspaces/:id/submit`. */
export interface SubmitRequest {
  /** The caller's id for this unit of work; the idempotency key. Printable, at most 200 chars. */
  externalKey: string;
  /** The one member of the new thread and the task's owner; must belong to the workspace. */
  botId: BotId;
  /** Task title and thread title. */
  title: string;
  /** Posted as the must-reply human message that wakes the bot. */
  instruction: string;
  /** Task description. */
  description?: string;
  /** Schema a `task_deliver` output must satisfy (ADR-0021 amendment 2). */
  outputSchema?: TaskOutputSchema;
  /** Thread deadline: an ISO 8601 date-time with a zone, in the future. */
  deadline?: IsoTimestamp;
  /** Attached to the instruction message. */
  attachments?: Attachment[];
  /**
   * The human named as author, honoured only for the shared operator credential, as on
   * `POST /api/threads/:id/messages`; a person or service principal is always itself.
   */
  authorId?: string;
}

/**
 * 201 for a new submission, 200 for a repeated key. `runs` are the runs the instruction woke,
 * as they are now: on a repeat they are the existing runs, not new ones.
 */
export interface SubmitResponse {
  threadId: ThreadId;
  taskId: string;
  messageId: MessageId;
  runs: Run[];
}

/** `GET /api/workspaces/:id/submissions?externalKey=`: one submission of the caller's channel. */
export interface SubmissionResponse {
  thread: Thread;
  /** The task linked to the thread; null only when an operator has unlinked it since. */
  task: Task | null;
  /** The thread's newest run; null when none has been created (for example, past deadline). */
  latestRun: Run | null;
}
