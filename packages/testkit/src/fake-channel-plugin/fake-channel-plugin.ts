// A fake ABI-2 channel provider (ADR-0047) for T1 tests of the Gateway's connection-scoped host,
// and a reference for provider plugin authors. It behaves the way a real provider plugin must:
// `verify` derives the identity from its own account lookup (never from the operator's input),
// inbound goes through `host.receive`, and every relay passes the send gate (`beginSend`, then
// `recordSend` with the fake provider's message id). Nothing here talks to a network.

import type {
  ChannelCapabilityMatrix,
  ChannelCloseReason,
  ChannelConnectionHost,
  ChannelConnectionStatus,
  ChannelInboundImage,
  ChannelInboundResult,
  ChannelOpenRequest,
  ChannelPluginManifestV2,
  ChannelPluginRuntimeV2,
  ChannelPluginV2,
  ChannelSendPermit,
  ChannelWebhookRequest,
} from "@deskmates/contracts";

export interface FakeChannelAccount {
  /** The provider's id for the bot or app; the identity key is `<plugin id>:bot:<accountId>`. */
  accountId: string;
  label: string;
}

/** One message the fake provider "sent" to a person, after the gate allowed it. */
export interface FakeChannelDelivery {
  connectionId: string;
  credentialGeneration: number;
  conversationKey: string;
  threadId: string;
  seq: number;
  body: string;
  providerMessageId: string;
}

export interface FakeChannelSkip {
  connectionId: string;
  threadId: string;
  seq: number;
  permit: Exclude<ChannelSendPermit, { send: true }>;
}

interface LiveConnection {
  request: ChannelOpenRequest;
  host: ChannelConnectionHost;
  abort: AbortController;
  /** Per-thread relay cursor: the highest seq handled. */
  cursors: Map<string, number>;
  /** Serializes relays of this connection. */
  chain: Promise<void>;
}

export interface FakeChannelOptions {
  id?: string;
  version?: string;
  multipleConnections?: boolean;
  capabilities?: Partial<Omit<ChannelCapabilityMatrix, "groups">>;
}

const DEFAULT_CAPABILITIES: ChannelCapabilityMatrix = {
  directMessages: "available",
  groups: "unavailable",
  inboundImages: "available",
  inboundOtherMedia: "disabled",
  outboundReply: "available",
  proactiveMessages: "unavailable",
  streaming: "disabled",
  approvals: "available",
  testMessage: "unavailable",
};

/**
 * The provider side and the plugin in one object. Tests register accounts (tokens the fake
 * provider knows), connect through the Gateway's API, then drive `deliver` and read `deliveries`.
 */
export class FakeChannelProvider {
  readonly plugin: ChannelPluginV2;
  /** How many times the Gateway created the runtime: 0 until a connection of it is used. */
  created = 0;
  readonly opens: { connectionId: string; reason: ChannelOpenRequest["reason"] }[] = [];
  readonly closes: { connectionId: string; reason: ChannelCloseReason }[] = [];
  readonly deliveries: FakeChannelDelivery[] = [];
  readonly skipped: FakeChannelSkip[] = [];
  readonly webhooks: ChannelWebhookRequest[] = [];
  /** Every host handed out, oldest first, so a test can call a stale one. */
  readonly hosts: ChannelConnectionHost[] = [];
  /** While set, relays wait here: a send is "queued" until the test releases it. */
  hold: Promise<void> | undefined;
  private readonly accounts = new Map<string, FakeChannelAccount>();
  private readonly live = new Map<string, LiveConnection>();
  private nextMessageId = 1;

  constructor(options: FakeChannelOptions = {}) {
    const id = options.id ?? "fakechat";
    const manifest: ChannelPluginManifestV2 = {
      apiVersion: 2,
      id,
      version: options.version ?? "1.0.0",
      displayName: `Fake ${id}`,
      description: "A fake ABI-2 provider for tests.",
      multipleConnections: options.multipleConnections ?? true,
      capabilities: { ...DEFAULT_CAPABILITIES, ...(options.capabilities ?? {}) },
      methods: [
        {
          id: "token",
          label: "Bot token",
          description: "Paste the bot token.",
          fields: [
            { key: "token", label: "Bot token", kind: "password", secret: true, required: true },
            { key: "note", label: "Note", kind: "text" },
          ],
        },
      ],
      statusVocabulary: ["connected", "stopped"],
    };
    const runtime = this.runtime();
    this.plugin = {
      manifest,
      create: async () => {
        this.created += 1;
        return runtime;
      },
    };
  }

  /** Make `token` a credential the fake provider accepts, belonging to `account`. */
  addAccount(token: string, account: FakeChannelAccount): void {
    this.accounts.set(token, account);
  }

  /** The current host of a connection. */
  host(connectionId: string): ChannelConnectionHost {
    const connection = this.live.get(connectionId);
    if (!connection) throw new Error(`fake connection ${connectionId} is not open`);
    return connection.host;
  }

  /** The open request a connection was last opened with. */
  request(connectionId: string): ChannelOpenRequest {
    const connection = this.live.get(connectionId);
    if (!connection) throw new Error(`fake connection ${connectionId} is not open`);
    return connection.request;
  }

  isOpen(connectionId: string): boolean {
    return this.live.has(connectionId);
  }

  /** A person writes to the bot behind `connectionId`; 1:1, so the conversation is the sender. */
  deliver(
    connectionId: string,
    input: {
      senderId: string;
      externalId: string;
      body: string;
      conversationKey?: string;
      images?: readonly ChannelInboundImage[];
    },
    host: ChannelConnectionHost = this.host(connectionId),
  ): Promise<ChannelInboundResult> {
    return host.receive({
      conversationKey: input.conversationKey ?? input.senderId,
      senderId: input.senderId,
      externalId: input.externalId,
      body: input.body,
      ...(input.images ? { images: input.images } : {}),
    });
  }

  /** Wait until every relay this provider started has finished. */
  async settle(): Promise<void> {
    for (let pass = 0; pass < 5; pass += 1) {
      await new Promise((done) => setTimeout(done, 10));
      await Promise.all([...this.live.values()].map((connection) => connection.chain));
    }
  }

  private relay(connection: LiveConnection, threadId: string): void {
    connection.chain = connection.chain
      .then(async () => {
        if (this.hold) await this.hold;
        const { host } = connection;
        const after = connection.cursors.get(threadId) ?? 0;
        const messages = await host.listMessages(threadId, after);
        const conversationKey = await host.conversationKeyOf(threadId);
        for (const message of messages) {
          const permit = await host.beginSend({ threadId, seq: message.seq });
          if (permit.send) {
            const providerMessageId = `fake-msg-${this.nextMessageId++}`;
            this.deliveries.push({
              connectionId: host.connectionId,
              credentialGeneration: connection.request.credentialGeneration,
              conversationKey,
              threadId,
              seq: message.seq,
              body: message.body,
              providerMessageId,
            });
            await host.recordSend({
              threadId,
              seq: message.seq,
              providerMessageIds: [providerMessageId],
            });
          } else if (permit.reason !== "sender_message") {
            this.skipped.push({
              connectionId: host.connectionId,
              threadId,
              seq: message.seq,
              permit,
            });
          }
          connection.cursors.set(threadId, message.seq);
        }
      })
      .catch(() => {
        // A stale host refuses every call; a real plugin logs and stops this connection's relay.
      });
  }

  private runtime(): ChannelPluginRuntimeV2 {
    const status = (connectionId: string): ChannelConnectionStatus =>
      this.live.has(connectionId)
        ? {
            phase: "connected",
            account: this.live.get(connectionId)?.request.identityKey ?? "",
          }
        : { phase: "stopped" };
    return {
      verify: async (request) => {
        const token = request.secrets.token ?? "";
        const account = this.accounts.get(token);
        if (!account) throw new Error("the fake provider refused the token");
        return {
          identityKey: `${this.plugin.manifest.id}:bot:${account.accountId}`,
          label: account.label,
        };
      },
      open: async (request, host) => {
        this.opens.push({ connectionId: request.connectionId, reason: request.reason });
        this.hosts.push(host);
        const connection: LiveConnection = {
          request,
          host,
          abort: new AbortController(),
          cursors: new Map(),
          chain: Promise.resolve(),
        };
        this.live.set(request.connectionId, connection);
        void host
          .subscribe(
            {
              onOpen: () => {},
              onFrame: (frame) => {
                if (frame.type === "thread_message") this.relay(connection, frame.threadId);
              },
            },
            connection.abort.signal,
          )
          .catch(() => {});
        return status(request.connectionId);
      },
      close: async (connectionId, reason) => {
        this.closes.push({ connectionId, reason });
        this.live.get(connectionId)?.abort.abort();
        this.live.delete(connectionId);
      },
      status: async (connectionId) => status(connectionId),
      test: async (connectionId) => status(connectionId),
      webhook: async (request) => {
        this.webhooks.push(request);
        return { status: 200, body: "ok" };
      },
      stop: async () => {
        for (const connection of this.live.values()) connection.abort.abort();
        this.live.clear();
      },
    };
  }
}
