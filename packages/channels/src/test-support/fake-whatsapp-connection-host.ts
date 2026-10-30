// A small in-memory `ChannelConnectionHost` (ADR-0047 decision 9) for provider plugin tests: one
// connection, one Bot, threads keyed by conversation, an allowlist or blocklist admission, the
// send gate with receipts, and a `stale` switch that makes every call fail the way the Gateway's
// host does. The Gateway's real host is covered by `packages/gateway/src/channels/*.test.ts`.

import {
  type Approval,
  type ChannelConnectionFrame,
  type ChannelConnectionHost,
  type ChannelIdentity,
  type ChannelInboundMessage,
  type ChannelInboundResult,
  type ChannelSendPermit,
  DeskmatesError,
  type Thread,
  type ThreadMessage,
  channelAuthorId,
} from "@deskmates/contracts";

export interface FakeConnectionHost extends ChannelConnectionHost {
  stale: boolean;
  /** `undefined`: blocklist mode with an empty list; a set: allowlist mode. */
  allowed: Set<string> | undefined;
  blocked: Set<string>;
  threads: Map<string, Thread>;
  messages: Map<string, ThreadMessage[]>;
  received: ChannelInboundMessage[];
  sent: { threadId: string; seq: number; providerMessageIds: readonly string[] }[];
  decided: { id: string; decision: string; senderId: string }[];
  claims: ChannelIdentity[];
  approvals: Map<string, Approval>;
  /** Make the next `claimIdentity` fail with this code. */
  refuseClaim: string | undefined;
  /** Append a message as a run would, and deliver its frame. */
  append(threadId: string, message: Partial<ThreadMessage> & { body: string }): ThreadMessage;
}

export function createFakeConnectionHost(
  options: { channel?: string; allowed?: Iterable<string>; botName?: string } = {},
): FakeConnectionHost {
  const channel = options.channel ?? "whatsapp";
  const listeners = new Set<(frame: ChannelConnectionFrame) => void>();
  const byKey = new Map<string, string>();
  let threadCount = 0;
  let messageCount = 0;
  const live = () => {
    if (host.stale) throw new DeskmatesError("channel_connection_stale", "stale");
  };
  const own = (threadId: string): Thread => {
    const thread = host.threads.get(threadId);
    if (!thread) throw new DeskmatesError("not_found", "channel thread not found");
    return thread;
  };
  const admitted = (senderId: string) =>
    host.allowed ? host.allowed.has(senderId) : !host.blocked.has(senderId);
  const append = (threadId: string, input: Partial<ThreadMessage> & { body: string }) => {
    const list = host.messages.get(threadId) ?? [];
    const message: ThreadMessage = {
      id: `msg_${++messageCount}`,
      threadId,
      seq: list.length + 1,
      authorKind: "bot",
      authorId: "bot_1",
      attachments: [],
      mentions: [],
      relayCount: 0,
      ts: "2026-10-17T00:00:00.000Z",
      ...input,
    } as ThreadMessage;
    list.push(message);
    host.messages.set(threadId, list);
    for (const listener of listeners) listener({ type: "thread_message", threadId, message });
    return message;
  };
  const host: FakeConnectionHost = {
    connectionId: "chn_fake",
    workspaceId: "ws_1" as Thread["workspaceId"],
    botId: "bot_1" as ChannelConnectionHost["botId"],
    bindingGeneration: 1,
    channel,
    stale: false,
    allowed: options.allowed ? new Set(options.allowed) : undefined,
    blocked: new Set(),
    threads: new Map(),
    messages: new Map(),
    received: [],
    sent: [],
    decided: [],
    claims: [],
    approvals: new Map(),
    refuseClaim: undefined,
    append,
    receive: async (input): Promise<ChannelInboundResult> => {
      live();
      if (!admitted(input.senderId)) return { status: "blocked" };
      for (const [threadId, list] of host.messages)
        for (const message of list)
          if (message.externalId === input.externalId)
            return { status: "duplicate", threadId, messageId: message.id };
      if (input.body.trim() === "") return { status: "empty", imagesRefused: 0 };
      host.received.push(input);
      let threadId = byKey.get(input.conversationKey);
      if (!threadId) {
        threadId = `thr_${++threadCount}`;
        byKey.set(input.conversationKey, threadId);
        host.threads.set(threadId, {
          id: threadId,
          workspaceId: host.workspaceId,
          channel,
          title: input.title ?? "",
          externalKey: `chn_fake:1:${input.conversationKey}`,
        } as unknown as Thread);
      }
      const message = append(threadId, {
        authorKind: "human",
        authorId: channelAuthorId(channel, input.senderId),
        body: input.body,
        externalId: input.externalId,
      });
      return { status: "posted", thread: own(threadId), message, runs: [], imagesRefused: 0 };
    },
    findThread: async (conversationKey) => {
      live();
      const id = byKey.get(conversationKey);
      return id ? host.threads.get(id) : undefined;
    },
    conversationKeyOf: async (threadId) => {
      live();
      return (own(threadId).externalKey ?? "").replace(/^chn_fake:1:/, "");
    },
    getThread: async (threadId) => {
      live();
      return {
        thread: own(threadId),
        members: [{ botId: host.botId, name: options.botName ?? "Helper" } as never],
      };
    },
    listMessages: async (threadId, afterSeq) => {
      live();
      own(threadId);
      return (host.messages.get(threadId) ?? []).filter((m) => m.seq > afterSeq);
    },
    getApproval: async (id) => {
      live();
      return host.approvals.get(id);
    },
    decideApproval: async (input) => {
      live();
      const approval = host.approvals.get(input.id);
      if (!approval) throw new DeskmatesError("not_found", "approval not found");
      if (!admitted(input.senderId)) throw new DeskmatesError("forbidden", "no");
      host.decided.push({ id: input.id, decision: input.decision, senderId: input.senderId });
      return approval;
    },
    beginSend: async ({ threadId, seq }): Promise<ChannelSendPermit> => {
      live();
      own(threadId);
      const message = (host.messages.get(threadId) ?? []).find((m) => m.seq === seq);
      if (!message) throw new DeskmatesError("not_found", "message not found");
      if (message.authorKind === "human" && message.authorId.startsWith(`${channel}:`))
        return { send: false, reason: "sender_message" };
      if (host.sent.some((s) => s.threadId === threadId && s.seq === seq))
        return { send: false, reason: "already_sent" };
      const people = (host.messages.get(threadId) ?? [])
        .filter((m) => m.authorKind === "human" && m.authorId.startsWith(`${channel}:`))
        .map((m) => m.authorId.slice(channel.length + 1));
      if (!people.every(admitted)) return { send: false, reason: "blocked" };
      return { send: true };
    },
    recordSend: async (input) => {
      live();
      host.sent.push(input);
    },
    subscribe: async (handlers, signal) => {
      live();
      await handlers.onOpen();
      await new Promise<void>((done) => {
        const listener = (frame: ChannelConnectionFrame) => void handlers.onFrame(frame);
        listeners.add(listener);
        signal.addEventListener("abort", () => {
          listeners.delete(listener);
          done();
        });
      });
    },
    admits: async (senderId) => {
      live();
      return admitted(senderId);
    },
    claimIdentity: async (identity) => {
      live();
      if (host.refuseClaim) throw new DeskmatesError(host.refuseClaim as never, "refused");
      host.claims.push(identity);
    },
    log: () => {},
  };
  return host;
}
