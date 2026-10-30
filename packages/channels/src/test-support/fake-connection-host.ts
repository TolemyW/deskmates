// An in-memory stand-in for the Gateway's ABI-2 connection-scoped host (ADR-0047 decision 9) for
// provider plugins' own T1 tests. It keeps the rules a plugin can observe: one thread per
// conversation and generation, deduplication by external id across the connection, the
// blocklist both ways, the send gate and its receipts, approvals decided only by a person who
// wrote in the thread, frames only for the connection's threads, and `channel_connection_stale`
// for a revoked host. The real host is tested in `packages/gateway/src/channels/*.test.ts`.

import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type Attachment,
  type BotId,
  CHANNEL_INBOUND_IMAGES_MAX,
  CHANNEL_INBOUND_IMAGE_MAX_BYTES,
  CHANNEL_INBOUND_IMAGE_TYPES,
  type ChannelConnectionFrame,
  type ChannelConnectionHost,
  type ChannelInboundMessage,
  type ChannelInboundResult,
  type ChannelOpenRequest,
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
  connectionId: string;
  generation: number;
  conversationKey: string;
  messages: ThreadMessage[];
}

export interface FakeReceipt {
  connectionId: string;
  threadId: string;
  seq: number;
  state: "sent" | "cancelled" | "blocked";
  providerMessageIds: readonly string[];
}

export interface FakeStoredImage {
  connectionId: string;
  name: string;
  mimeType: string;
  bytes: number;
}

interface Listener {
  connectionId: string;
  generation: number;
  onFrame(frame: ChannelConnectionFrame): void | Promise<void>;
}

/** A tiny Gateway: threads, messages, receipts, approvals and hosts for several connections. */
export class FakeChannelHub {
  readonly receives: { connectionId: string; input: ChannelInboundMessage }[] = [];
  readonly receipts: FakeReceipt[] = [];
  readonly images: FakeStoredImage[] = [];
  readonly logs: { level: string; message: string; data?: unknown }[] = [];
  readonly decisions: { id: string; decision: string; authorId: string }[] = [];
  private readonly threads = new Map<string, FakeThread>();
  private readonly blocked = new Map<string, Set<string>>();
  private readonly approvals = new Map<string, Approval & { decided?: boolean }>();
  private readonly latest = new Map<string, symbol>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private nextThread = 1;
  private nextMessage = 1;

  constructor(readonly channel: string) {}

  /** A host for the connection as opened now; every earlier host of it becomes stale. */
  hostFor(request: ChannelOpenRequest): ChannelConnectionHost {
    const token = Symbol(request.connectionId);
    this.latest.set(request.connectionId, token);
    this.generations.set(request.connectionId, request.bindingGeneration);
    const id = request.connectionId;
    const generation = request.bindingGeneration;
    const live = (): void => {
      if (this.latest.get(id) !== token || this.generations.get(id) !== generation)
        throw new DeskmatesError("channel_connection_stale", "stale", { connectionId: id });
    };
    const own = (threadId: string): FakeThread => {
      const entry = this.threads.get(threadId);
      if (!entry || entry.connectionId !== id || entry.generation !== generation)
        throw new DeskmatesError("not_found", "channel thread not found");
      return entry;
    };
    const hub = this;
    return {
      connectionId: id,
      workspaceId: request.workspaceId,
      botId: request.botId,
      bindingGeneration: generation,
      channel: this.channel,
      async receive(input) {
        live();
        hub.receives.push({ connectionId: id, input });
        return hub.receive(id, generation, request, input);
      },
      async findThread(conversationKey) {
        live();
        return hub.find(id, generation, conversationKey)?.thread;
      },
      async conversationKeyOf(threadId) {
        live();
        return own(threadId).conversationKey;
      },
      async getThread(threadId) {
        live();
        const entry = own(threadId);
        return {
          thread: entry.thread,
          members: [{ threadId: entry.thread.id, botId: request.botId, name: "Bot" } as never],
        };
      },
      async listMessages(threadId, afterSeq) {
        live();
        return own(threadId).messages.filter((m) => m.seq > afterSeq);
      },
      async getApproval(approvalId) {
        live();
        const approval = hub.approvals.get(approvalId);
        if (!approval?.threadId) return undefined;
        const entry = hub.threads.get(approval.threadId);
        return entry && entry.connectionId === id && entry.generation === generation
          ? approval
          : undefined;
      },
      async decideApproval(input) {
        live();
        const approval = hub.approvals.get(input.id);
        const entry = approval?.threadId ? hub.threads.get(approval.threadId) : undefined;
        if (!approval || !entry || entry.connectionId !== id || entry.generation !== generation)
          throw new DeskmatesError("not_found", "approval not found");
        const authorId = channelAuthorId(hub.channel, input.senderId);
        const wrote = entry.messages.some(
          (m) => m.authorKind === "human" && m.authorId === authorId,
        );
        if (!wrote || hub.isBlocked(id, input.senderId))
          throw new DeskmatesError("forbidden", "only the conversation's own person decides here");
        if (approval.decided) throw new DeskmatesError("invalid_transition", "already decided");
        approval.decided = true;
        approval.decision = input.decision;
        hub.decisions.push({ id: input.id, decision: input.decision, authorId });
        return approval;
      },
      async beginSend(input) {
        live();
        const entry = own(input.threadId);
        const message = entry.messages.find((m) => m.seq === input.seq);
        if (!message) throw new DeskmatesError("not_found", "message not found");
        if (message.authorKind === "human" && message.authorId.startsWith(`${hub.channel}:`))
          return { send: false, reason: "sender_message" };
        const receipt = hub.receipts.find(
          (r) => r.threadId === input.threadId && r.seq === input.seq,
        );
        if (receipt?.state === "sent") return { send: false, reason: "already_sent" };
        if (receipt) return { send: false, reason: receipt.state };
        if (hub.isBlocked(id, conversationSender(entry))) {
          hub.receipts.push({
            connectionId: id,
            threadId: input.threadId,
            seq: input.seq,
            state: "blocked",
            providerMessageIds: [],
          });
          return { send: false, reason: "blocked" };
        }
        return { send: true };
      },
      async recordSend(input) {
        live();
        own(input.threadId);
        hub.receipts.push({
          connectionId: id,
          threadId: input.threadId,
          seq: input.seq,
          state: "sent",
          providerMessageIds: [...input.providerMessageIds],
        });
      },
      async subscribe(handlers, signal) {
        live();
        await handlers.onOpen();
        await new Promise<void>((done) => {
          const listener: Listener = { connectionId: id, generation, onFrame: handlers.onFrame };
          const end = (): void => {
            hub.listeners.delete(listener);
            done();
          };
          listener.onFrame = (frame) => {
            if (hub.latest.get(id) !== token) return end();
            return handlers.onFrame(frame);
          };
          hub.listeners.add(listener);
          if (signal.aborted) end();
          else signal.addEventListener("abort", end, { once: true });
        });
      },
      log(level, message, data) {
        hub.logs.push({ level, message, ...(data ? { data } : {}) });
      },
    };
  }

  /** Make every host of the connection stale (disconnect, rebind fence). */
  revoke(connectionId: string): void {
    this.latest.delete(connectionId);
  }

  block(connectionId: string, senderId: string): void {
    const set = this.blocked.get(connectionId) ?? new Set();
    set.add(senderId);
    this.blocked.set(connectionId, set);
  }

  isBlocked(connectionId: string, senderId: string | undefined): boolean {
    return senderId !== undefined && (this.blocked.get(connectionId)?.has(senderId) ?? false);
  }

  /** Every thread of a connection. */
  threadsOf(connectionId: string): (Thread & { conversationKey: string })[] {
    return [...this.threads.values()]
      .filter((t) => t.connectionId === connectionId)
      .map((t) => ({ ...t.thread, conversationKey: t.conversationKey }));
  }

  messages(threadId: string): ThreadMessage[] {
    return [...(this.threads.get(threadId)?.messages ?? [])];
  }

  /** The bound Bot answers in a thread; subscribers get the frame. */
  reply(threadId: string, body: string, attachments: Attachment[] = []): ThreadMessage {
    const entry = this.threads.get(threadId);
    if (!entry) throw new Error(`no thread ${threadId}`);
    return this.append(entry, {
      authorKind: "bot",
      authorId: String(entry.thread.id),
      body,
      attachments,
    });
  }

  /** A pending approval request in the thread, as the Gateway posts it. */
  requestApproval(threadId: string, approvalId: string): ThreadMessage {
    const entry = this.threads.get(threadId);
    if (!entry) throw new Error(`no thread ${threadId}`);
    this.approvals.set(approvalId, {
      id: approvalId,
      threadId: entry.thread.id,
      botId: "bot" as BotId,
    } as unknown as Approval);
    return this.append(entry, {
      authorKind: "system",
      authorId: "",
      body: "The assistant asks to send an e-mail.",
      attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: approvalId }],
    });
  }

  approval(id: string): (Approval & { decided?: boolean }) | undefined {
    return this.approvals.get(id);
  }

  private find(
    connectionId: string,
    generation: number,
    conversationKey: string,
  ): FakeThread | undefined {
    for (const entry of this.threads.values())
      if (
        entry.connectionId === connectionId &&
        entry.generation === generation &&
        entry.conversationKey === conversationKey
      )
        return entry;
    return undefined;
  }

  private receive(
    connectionId: string,
    generation: number,
    request: ChannelOpenRequest,
    input: ChannelInboundMessage,
  ): ChannelInboundResult {
    if (this.isBlocked(connectionId, input.senderId)) return { status: "blocked" };
    for (const entry of this.threads.values()) {
      if (entry.connectionId !== connectionId) continue;
      const duplicate = entry.messages.find((m) => m.externalId === input.externalId);
      if (duplicate)
        return { status: "duplicate", threadId: entry.thread.id, messageId: duplicate.id };
    }
    const attachments: Attachment[] = [];
    let refused = 0;
    for (const [index, image] of (input.images ?? []).entries()) {
      if (
        index >= CHANNEL_INBOUND_IMAGES_MAX ||
        !CHANNEL_INBOUND_IMAGE_TYPES.includes(image.mimeType) ||
        image.bytes.byteLength === 0 ||
        image.bytes.byteLength > CHANNEL_INBOUND_IMAGE_MAX_BYTES
      ) {
        refused += 1;
        continue;
      }
      this.images.push({
        connectionId,
        name: image.name,
        mimeType: image.mimeType,
        bytes: image.bytes.byteLength,
      });
      attachments.push({
        name: image.name,
        mimeType: image.mimeType,
        ref: `/work/uploads/fake/${image.name}`,
        uploadId: `upload-${this.images.length}`,
        sizeBytes: image.bytes.byteLength,
      });
    }
    if (input.body.trim() === "" && attachments.length === 0)
      return { status: "empty", imagesRefused: refused };
    let entry = this.find(connectionId, generation, input.conversationKey);
    if (!entry) {
      const thread = {
        id: `thread-${this.nextThread++}` as ThreadId,
        workspaceId: request.workspaceId as WorkspaceId,
        kind: "chat",
        channel: this.channel,
        externalKey: `${connectionId}:${generation}:${input.conversationKey}`,
        channelConnectionId: connectionId,
        bindingGeneration: generation,
        title: input.title ?? `${this.channel} ${input.senderId}`,
      } as unknown as Thread;
      entry = {
        thread,
        connectionId,
        generation,
        conversationKey: input.conversationKey,
        messages: [],
      };
      this.threads.set(thread.id, entry);
    }
    const message = this.append(entry, {
      authorKind: "human",
      authorId: channelAuthorId(this.channel, input.senderId),
      body: input.body,
      attachments,
      externalId: input.externalId,
    });
    return { status: "posted", thread: entry.thread, message, runs: [], imagesRefused: refused };
  }

  private append(
    entry: FakeThread,
    input: Pick<ThreadMessage, "authorKind" | "authorId" | "body" | "attachments"> & {
      externalId?: string;
    },
  ): ThreadMessage {
    const message: ThreadMessage = {
      id: `message-${this.nextMessage++}` as MessageId,
      threadId: entry.thread.id,
      seq: entry.messages.length + 1,
      mentions: [],
      relayCount: 0,
      ts: new Date().toISOString() as ThreadMessage["ts"],
      ...input,
    };
    entry.messages.push(message);
    for (const listener of this.listeners)
      if (listener.connectionId === entry.connectionId && listener.generation === entry.generation)
        void listener.onFrame({ type: "thread_message", threadId: entry.thread.id, message });
    return message;
  }
}

/** The sender a 1:1 thread belongs to: the author of its first human message. */
function conversationSender(entry: FakeThread): string | undefined {
  const first = entry.messages.find((m) => m.authorKind === "human");
  return first ? first.authorId.slice(first.authorId.indexOf(":") + 1) : undefined;
}
