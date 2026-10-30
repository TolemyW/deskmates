// An in-memory stand-in for the Gateway side of one ABI-2 connection (ADR-0047 decision 9), for
// T1 tests of provider plugins. It keeps what the Gateway keeps for a connection (threads per
// conversation, messages, the blocklist, outbound receipts, approvals) and hands out hosts the way
// `ConnectionHosts.issue` does: issuing a new host makes every earlier one stale, and a stale host
// throws `channel_connection_stale` with no effect. The real host is proven by the Gateway's own
// T1 tests (`packages/gateway/src/channels/connection-host.test.ts`); this fake mirrors its
// contract so a plugin can be tested without the Gateway.

import {
  type Approval,
  type Attachment,
  type BotId,
  CHANNEL_INBOUND_IMAGES_MAX,
  CHANNEL_INBOUND_IMAGE_MAX_BYTES,
  CHANNEL_INBOUND_IMAGE_TYPES,
  type ChannelConnectionFrame,
  type ChannelConnectionHost,
  type ChannelInboundImage,
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

export interface FakeLogLine {
  level: "info" | "warn";
  message: string;
  data?: Readonly<Record<string, unknown>>;
}

interface Listener {
  onFrame(frame: ChannelConnectionFrame): void | Promise<void>;
  end(): void;
  host: symbol;
}

export class FakeConnectionGateway {
  readonly threads = new Map<string, FakeThread>();
  readonly blocked = new Set<string>();
  readonly receipts = new Map<string, { state: "sent" | "blocked"; ids: readonly string[] }>();
  readonly approvals = new Map<string, { threadId: string; status: "pending" | "decided" }>();
  readonly decisions: { id: string; decision: string; senderId: string; reason?: string }[] = [];
  readonly storedImages: { name: string; mimeType: string; bytes: Uint8Array }[] = [];
  readonly logs: FakeLogLine[] = [];
  /** Every `receive` call, admitted or not. */
  readonly receiveCalls: ChannelInboundMessage[] = [];
  /** False models a stopped workspace: images are refused, text still posts. */
  imagesStorable = true;
  messagePageSize = Number.POSITIVE_INFINITY;
  bindingGeneration = 1;
  private current: symbol | undefined;
  private readonly listeners = new Set<Listener>();
  private nextThread = 1;
  private nextMessage = 1;

  constructor(
    readonly connectionId: string,
    readonly workspaceId: string,
    readonly botId: string,
    readonly channel = "telegram",
  ) {}

  /** A new host for the connection; every earlier host is stale from now on. */
  issue(): ChannelConnectionHost {
    const token = Symbol("host");
    this.current = token;
    for (const listener of [...this.listeners]) if (listener.host !== token) listener.end();
    return this.host(token);
  }

  /** Make every host stale without issuing a new one (a disconnect). */
  revoke(): void {
    this.current = undefined;
    for (const listener of [...this.listeners]) listener.end();
  }

  /** The thread of a provider conversation, if one exists. */
  threadOf(conversationKey: string): FakeThread | undefined {
    return [...this.threads.values()].find((t) => t.conversationKey === conversationKey);
  }

  /** The bound Bot (or the Gateway) writes in a thread; subscribers get the frame. */
  append(
    threadId: string,
    input: { body: string; authorKind?: "bot" | "system"; attachments?: Attachment[] },
  ): ThreadMessage {
    const entry = this.mustThread(threadId);
    const message = this.message(entry, {
      authorKind: input.authorKind ?? "bot",
      authorId: input.authorKind === "system" ? "" : this.botId,
      body: input.body,
      attachments: input.attachments ?? [],
    });
    this.publish({ type: "thread_message", threadId, message });
    return message;
  }

  addApproval(id: string, threadId: string): void {
    this.approvals.set(id, { threadId, status: "pending" });
  }

  private publish(frame: ChannelConnectionFrame): void {
    for (const listener of this.listeners) void listener.onFrame(frame);
  }

  private mustThread(threadId: string): FakeThread {
    const entry = this.threads.get(threadId);
    if (!entry) throw new DeskmatesError("not_found", "thread not found");
    return entry;
  }

  private message(
    entry: FakeThread,
    input: Pick<ThreadMessage, "authorKind" | "authorId" | "body" | "attachments"> & {
      externalId?: string;
    },
  ): ThreadMessage {
    const message: ThreadMessage = {
      id: `msg-${this.nextMessage++}` as MessageId,
      threadId: entry.thread.id,
      seq: entry.messages.length + 1,
      authorKind: input.authorKind,
      authorId: input.authorId,
      body: input.body,
      attachments: input.attachments,
      mentions: [],
      relayCount: 0,
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ts: new Date(0).toISOString() as ThreadMessage["ts"],
    };
    entry.messages.push(message);
    return message;
  }

  private host(token: symbol): ChannelConnectionHost {
    const live = (): void => {
      if (this.current !== token)
        throw new DeskmatesError("channel_connection_stale", "this connection handle is stale");
    };
    const own = (threadId: string): FakeThread => {
      const entry = this.threads.get(threadId);
      if (!entry) throw new DeskmatesError("not_found", "thread not found");
      return entry;
    };
    const author = (senderId: string) => channelAuthorId(this.channel, senderId);
    return {
      connectionId: this.connectionId,
      workspaceId: this.workspaceId as WorkspaceId,
      botId: this.botId as BotId,
      bindingGeneration: this.bindingGeneration,
      channel: this.channel,
      receive: async (input): Promise<ChannelInboundResult> => {
        live();
        this.receiveCalls.push(input);
        if (this.blocked.has(input.senderId)) return { status: "blocked" };
        for (const entry of this.threads.values()) {
          const found = entry.messages.find((m) => m.externalId === input.externalId);
          if (found) return { status: "duplicate", threadId: entry.thread.id, messageId: found.id };
        }
        const attachments: Attachment[] = [];
        let refused = 0;
        for (const [index, image] of (input.images ?? []).entries()) {
          if (!this.storable(image, index)) {
            refused += 1;
            continue;
          }
          this.storedImages.push(image);
          attachments.push({
            name: image.name,
            mimeType: image.mimeType,
            ref: `/work/uploads/fake/${image.name}`,
            uploadId: `upload-${this.storedImages.length}`,
            sizeBytes: image.bytes.byteLength,
          });
        }
        if (input.body.trim() === "" && attachments.length === 0)
          return { status: "empty", imagesRefused: refused };
        let entry = this.threadOf(input.conversationKey);
        if (!entry) {
          const id = `${this.connectionId}-thread-${this.nextThread++}` as ThreadId;
          entry = {
            // The fake fills only the fields a plugin reads.
            thread: {
              id,
              workspaceId: this.workspaceId as WorkspaceId,
              kind: "chat",
              channel: this.channel,
              externalKey: `${this.connectionId}:${this.bindingGeneration}:${input.conversationKey}`,
              channelConnectionId: this.connectionId,
              bindingGeneration: this.bindingGeneration,
              title: input.title ?? `${this.channel} ${input.senderId}`,
            } as unknown as Thread,
            conversationKey: input.conversationKey,
            senderId: input.senderId,
            messages: [],
          };
          this.threads.set(id, entry);
        }
        const message = this.message(entry, {
          authorKind: "human",
          authorId: author(input.senderId),
          body: input.body,
          attachments,
          externalId: input.externalId,
        });
        this.publish({ type: "thread_message", threadId: entry.thread.id, message });
        return {
          status: "posted",
          thread: entry.thread,
          message,
          runs: [],
          imagesRefused: refused,
        };
      },
      findThread: async (conversationKey) => {
        live();
        return this.threadOf(conversationKey)?.thread;
      },
      conversationKeyOf: async (threadId) => {
        live();
        return own(threadId).conversationKey;
      },
      getThread: async (threadId) => {
        live();
        const entry = own(threadId);
        return {
          thread: entry.thread,
          members: [
            {
              threadId: entry.thread.id,
              botId: this.botId as BotId,
              lastSeenSeq: 0,
              joinedAt: new Date(0).toISOString() as ThreadMessage["ts"],
              name: "Bot",
            },
          ],
        };
      },
      listThreads: async () => {
        live();
        return [...this.threads.values()]
          .filter((entry) => entry.thread.bindingGeneration === this.bindingGeneration)
          .map((entry) => entry.thread.id);
      },
      listMessages: async (threadId, afterSeq) => {
        live();
        return own(threadId)
          .messages.filter((m) => m.seq > afterSeq)
          .slice(0, this.messagePageSize);
      },
      getApproval: async (id) => {
        live();
        const approval = this.approvals.get(id);
        if (!approval || !this.threads.has(approval.threadId)) return undefined;
        return { id, threadId: approval.threadId } as unknown as Approval;
      },
      decideApproval: async (input) => {
        live();
        const approval = this.approvals.get(input.id);
        if (!approval || !this.threads.has(approval.threadId))
          throw new DeskmatesError("not_found", "approval not found");
        const entry = own(approval.threadId);
        const wrote = entry.messages.some(
          (m) => m.authorKind === "human" && m.authorId === author(input.senderId),
        );
        if (!wrote || this.blocked.has(input.senderId))
          throw new DeskmatesError("forbidden", "only the conversation's own person decides here");
        if (approval.status !== "pending")
          throw new DeskmatesError("invalid_transition", "approval already decided");
        approval.status = "decided";
        this.decisions.push({
          id: input.id,
          decision: input.decision,
          senderId: input.senderId,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        return { id: input.id, threadId: approval.threadId } as unknown as Approval;
      },
      beginSend: async (input): Promise<ChannelSendPermit> => {
        live();
        const entry = own(input.threadId);
        const message = entry.messages.find((m) => m.seq === input.seq);
        if (!message) throw new DeskmatesError("not_found", "message not found");
        if (message.authorKind === "human" && message.authorId.startsWith(`${this.channel}:`))
          return { send: false, reason: "sender_message" };
        const receipt = this.receipts.get(`${input.threadId}:${input.seq}`);
        if (receipt?.state === "sent") return { send: false, reason: "already_sent" };
        if (receipt) return { send: false, reason: "blocked" };
        if (this.blocked.has(entry.senderId)) {
          this.receipts.set(`${input.threadId}:${input.seq}`, { state: "blocked", ids: [] });
          return { send: false, reason: "blocked" };
        }
        return { send: true };
      },
      recordSend: async (input) => {
        live();
        own(input.threadId);
        this.receipts.set(`${input.threadId}:${input.seq}`, {
          state: "sent",
          ids: [...input.providerMessageIds],
        });
      },
      subscribe: async (handlers, signal) => {
        live();
        await handlers.onOpen();
        await new Promise<void>((done) => {
          const listener: Listener = {
            host: token,
            onFrame: (frame) => handlers.onFrame(frame),
            end: () => {
              this.listeners.delete(listener);
              done();
            },
          };
          this.listeners.add(listener);
          if (signal.aborted) listener.end();
          else signal.addEventListener("abort", () => listener.end(), { once: true });
        });
      },
      log: (level, message, data) => {
        this.logs.push({ level, message, ...(data ? { data } : {}) });
      },
    };
  }

  private storable(image: ChannelInboundImage, index: number): boolean {
    return (
      this.imagesStorable &&
      index < CHANNEL_INBOUND_IMAGES_MAX &&
      CHANNEL_INBOUND_IMAGE_TYPES.includes(image.mimeType) &&
      image.bytes.byteLength > 0 &&
      image.bytes.byteLength <= CHANNEL_INBOUND_IMAGE_MAX_BYTES
    );
  }
}
