// A fake `ChannelConnectionHost` for the Slack plugin's T1 tests: the host semantics the provider
// guide describes (blocklist, idempotency by external id, one-member threads per conversation, the
// send gate, approval scoping, staleness), in memory. The Gateway's real host has its own T1 tests
// in `packages/gateway/src/channels/`; this one only lets the plugin be driven without a Gateway.

import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type ApprovalId,
  type BotId,
  type ChannelConnectionFrame,
  type ChannelConnectionHost,
  type ChannelInboundMessage,
  type ChannelInboundResult,
  type ChannelSendPermit,
  DeskmatesError,
  type MessageId,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type WorkspaceId,
  channelAuthorId,
} from "@deskmates/contracts";

interface FakeThread {
  thread: Thread;
  conversationKey: string;
  senderId: string;
  messages: ThreadMessage[];
}

export interface FakeHostLog {
  level: "info" | "warn";
  message: string;
  data?: Readonly<Record<string, unknown>>;
}

export class FakeConnectionHost implements ChannelConnectionHost {
  readonly channel = "slack";
  readonly receives: ChannelInboundMessage[] = [];
  readonly logs: FakeHostLog[] = [];
  readonly receipts = new Map<string, { state: "sent" | "blocked"; ids: readonly string[] }>();
  readonly decisions: { id: string; decision: string; senderId: string; reason?: string }[] = [];
  readonly blocked = new Set<string>();
  readonly approvals = new Map<string, Approval>();
  private readonly threads = new Map<string, FakeThread>();
  private readonly byConversation = new Map<string, string>();
  private readonly externalIds = new Map<string, { threadId: string; messageId: string }>();
  private readonly handlers = new Set<(frame: ChannelConnectionFrame) => void>();
  private stale = false;
  private nextId = 1;

  constructor(
    readonly connectionId: string,
    readonly workspaceId = "ws_1" as WorkspaceId,
    readonly botId = "bot_1" as BotId,
    readonly bindingGeneration = 1,
  ) {}

  /** Make every later call throw `channel_connection_stale`, as after a rebind. */
  makeStale(): void {
    this.stale = true;
    this.handlers.clear();
  }

  threadOf(conversationKey: string): FakeThread | undefined {
    const id = this.byConversation.get(conversationKey);
    return id ? this.threads.get(id) : undefined;
  }

  allThreads(): FakeThread[] {
    return [...this.threads.values()];
  }

  private live(): void {
    if (this.stale) throw new DeskmatesError("channel_connection_stale", "stale handle");
  }

  private own(threadId: string): FakeThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new DeskmatesError("not_found", "thread not found");
    return thread;
  }

  private publish(thread: FakeThread, message: ThreadMessage): void {
    for (const handler of this.handlers)
      handler({ type: "thread_message", threadId: thread.thread.id, message });
  }

  private append(
    thread: FakeThread,
    input: Pick<ThreadMessage, "authorKind" | "authorId" | "body"> &
      Partial<Pick<ThreadMessage, "attachments" | "externalId">>,
  ): ThreadMessage {
    const message: ThreadMessage = {
      id: `msg_${this.nextId++}` as MessageId,
      threadId: thread.thread.id,
      seq: thread.messages.length + 1,
      authorKind: input.authorKind,
      authorId: input.authorId,
      body: input.body,
      attachments: input.attachments ?? [],
      mentions: [],
      relayCount: 0,
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ts: new Date().toISOString() as ThreadMessage["ts"],
    };
    thread.messages.push(message);
    this.publish(thread, message);
    return message;
  }

  /** The bound Bot answers in a thread. */
  reply(threadId: string, body: string): ThreadMessage {
    return this.append(this.own(threadId), { authorKind: "bot", authorId: this.botId, body });
  }

  /** A pending approval request in a thread, as a `system` message with its attachment. */
  requestApproval(threadId: string, id: string): Approval {
    const thread = this.own(threadId);
    const message = this.append(thread, {
      authorKind: "system",
      authorId: "",
      body: "The Bot asks to send an e-mail.",
      attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: id }],
    });
    const approval = {
      id: id as ApprovalId,
      threadId: thread.thread.id,
      messageId: message.id,
      botId: this.botId,
    } as unknown as Approval;
    this.approvals.set(id, approval);
    return approval;
  }

  async receive(input: ChannelInboundMessage): Promise<ChannelInboundResult> {
    this.live();
    this.receives.push(input);
    if (this.blocked.has(input.senderId)) return { status: "blocked" };
    const duplicate = this.externalIds.get(input.externalId);
    if (duplicate) return { status: "duplicate", ...duplicate };
    const images = input.images ?? [];
    if (input.body.trim() === "" && images.length === 0)
      return { status: "empty", imagesRefused: 0 };
    let thread = this.threadOf(input.conversationKey);
    if (!thread) {
      const id = `thr_${this.nextId++}` as ThreadId;
      thread = {
        thread: {
          id,
          workspaceId: this.workspaceId,
          channel: this.channel,
          externalKey: `${this.connectionId}:${this.bindingGeneration}:${input.conversationKey}`,
          channelConnectionId: this.connectionId,
          bindingGeneration: this.bindingGeneration,
          title: input.title ?? `slack ${input.senderId}`,
        } as unknown as Thread,
        conversationKey: input.conversationKey,
        senderId: input.senderId,
        messages: [],
      };
      this.threads.set(id, thread);
      this.byConversation.set(input.conversationKey, id);
    }
    const message = this.append(thread, {
      authorKind: "human",
      authorId: channelAuthorId(this.channel, input.senderId),
      body: input.body,
      externalId: input.externalId,
      attachments: images.map((image, index) => ({
        name: image.name,
        mimeType: image.mimeType,
        ref: `/work/uploads/fake/${index}`,
        sizeBytes: image.bytes.byteLength,
      })),
    });
    this.externalIds.set(input.externalId, { threadId: thread.thread.id, messageId: message.id });
    return { status: "posted", thread: thread.thread, message, runs: [], imagesRefused: 0 };
  }

  async findThread(conversationKey: string): Promise<Thread | undefined> {
    this.live();
    return this.threadOf(conversationKey)?.thread;
  }

  async conversationKeyOf(threadId: string): Promise<string> {
    this.live();
    return this.own(threadId).conversationKey;
  }

  async getThread(threadId: string) {
    this.live();
    const thread = this.own(threadId);
    return {
      thread: thread.thread,
      members: [
        {
          threadId: thread.thread.id,
          botId: this.botId,
          lastSeenSeq: 0,
          joinedAt: new Date().toISOString() as ThreadMessage["ts"],
          name: "Deskbot",
        },
      ],
    };
  }

  async listMessages(threadId: string, afterSeq: number): Promise<ThreadMessage[]> {
    this.live();
    return this.own(threadId).messages.filter((message) => message.seq > afterSeq);
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    this.live();
    return this.approvals.get(id);
  }

  async decideApproval(input: {
    id: string;
    decision: "allow_once" | "deny";
    senderId: string;
    reason?: string;
  }): Promise<Approval> {
    this.live();
    const approval = this.approvals.get(input.id);
    if (!approval?.threadId) throw new DeskmatesError("not_found", "approval not found");
    const thread = this.own(approval.threadId);
    if (thread.senderId !== input.senderId || this.blocked.has(input.senderId))
      throw new DeskmatesError("forbidden", "only the conversation's own person decides here");
    this.decisions.push({ ...input });
    const decided = { ...approval, decision: input.decision } as Approval;
    this.approvals.set(input.id, decided);
    return decided;
  }

  async beginSend(input: { threadId: string; seq: number }): Promise<ChannelSendPermit> {
    this.live();
    const thread = this.own(input.threadId);
    const message = thread.messages.find((candidate) => candidate.seq === input.seq);
    if (!message) throw new DeskmatesError("not_found", "message not found");
    if (message.authorKind === "human") return { send: false, reason: "sender_message" };
    const key = `${input.threadId}:${input.seq}`;
    const receipt = this.receipts.get(key);
    if (receipt?.state === "sent") return { send: false, reason: "already_sent" };
    if (this.blocked.has(thread.senderId)) {
      this.receipts.set(key, { state: "blocked", ids: [] });
      return { send: false, reason: "blocked" };
    }
    return { send: true };
  }

  async recordSend(input: {
    threadId: string;
    seq: number;
    providerMessageIds: readonly string[];
  }): Promise<void> {
    this.live();
    this.own(input.threadId);
    this.receipts.set(`${input.threadId}:${input.seq}`, {
      state: "sent",
      ids: [...input.providerMessageIds],
    });
  }

  async subscribe(
    handlers: {
      onFrame(frame: ChannelConnectionFrame): void | Promise<void>;
      onOpen(): void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void> {
    this.live();
    await handlers.onOpen();
    await new Promise<void>((done) => {
      const handler = (frame: ChannelConnectionFrame): void => {
        void handlers.onFrame(frame);
      };
      this.handlers.add(handler);
      const end = (): void => {
        this.handlers.delete(handler);
        done();
      };
      if (signal.aborted) end();
      else signal.addEventListener("abort", end, { once: true });
    });
  }

  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void {
    this.logs.push({ level, message, ...(data ? { data } : {}) });
  }
}
