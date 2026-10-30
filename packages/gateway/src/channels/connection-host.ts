// The ABI-2 host (ADR-0047 decision 9): every service a provider plugin uses, scoped to one
// connection, its workspace, its bound Bot and its binding generation, checked by the Gateway on
// every call. `issue` hands out a new host and makes every earlier host of that connection stale,
// so a reconnect, relink, rebind or disconnect leaves an old handle with no effect at all, and a
// host of a workspace in Trash does nothing (ADR-0017 amendment 1 P6).
// Admission follows the plugin's declaration (ADR-0047 decision 13 and amendment 1): the
// connection's blocklist by default, or a deny-by-default allowlist held in one config field.

import { createHash } from "node:crypto";
import {
  type ApprovalId,
  type Attachment,
  CHANNEL_IDENTITY_LABEL_MAX,
  CHANNEL_INBOUND_IMAGES_MAX,
  CHANNEL_INBOUND_IMAGE_MAX_BYTES,
  CHANNEL_INBOUND_IMAGE_TYPES,
  type ChannelConnectionHost,
  type ChannelInboundImage,
  type ChannelInboundMessage,
  type ChannelInboundResult,
  type ChannelSendPermit,
  type ChannelSenderAdmission,
  DeskmatesError,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  channelAuthorId,
  channelRebindNotice,
  decidedByHuman,
  isChannelIdentityKey,
  isExternalRef,
  parseChannelSenderList,
} from "@deskmates/contracts";
import type { ApprovalStore } from "../approvals/approvals.js";
import type { ApprovalBroker } from "../approvals/broker.js";
import type { BotStore } from "../bots/bots.js";
import type { GatewayDb } from "../db/open.js";
import type { EventBus } from "../events/bus.js";
import type { ChannelImageStore } from "../files/channel-image-upload.js";
import type { Ownership } from "../tenancy/ownership.js";
import type { TenantQuotas } from "../tenancy/quotas.js";
import type { MessageStore } from "../threads/messages.js";
import type { ThreadRouter } from "../threads/router.js";
import type { ThreadStore } from "../threads/threads.js";
import type { ChannelStore, StoredChannelConnection } from "./channel-store.js";
import { syncConversationActivity } from "./conversation-activity.js";
import type { OutboundReceipts } from "./outbound-receipts.js";
import type { SenderBlocks } from "./sender-blocks.js";

export interface ConnectionHostDeps {
  db: GatewayDb;
  store: ChannelStore;
  threads: ThreadStore;
  messages: MessageStore;
  router: ThreadRouter;
  approvals: ApprovalStore;
  broker: ApprovalBroker;
  bots: BotStore;
  ownership: Ownership;
  quotas: TenantQuotas;
  bus: EventBus;
  blocks: SenderBlocks;
  receipts: OutboundReceipts;
  kick(): void;
  /** Absent until the Gateway context exists; images are refused until then. */
  storeImage(): ChannelImageStore | undefined;
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
}

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function stale(connectionId: string): DeskmatesError {
  return new DeskmatesError(
    "channel_connection_stale",
    "This channel connection was disconnected, rebound or reopened; nothing was done.",
    { connectionId },
  );
}

function archived(connectionId: string): DeskmatesError {
  return new DeskmatesError(
    "channel_connection_stale",
    "This channel connection is stopped while its workspace is in Trash; nothing was done.",
    { connectionId, reason: "workspace_archived" },
  );
}

function notOwn(): DeskmatesError {
  return new DeskmatesError("not_found", "channel thread not found");
}

function ref(value: unknown, field: string): string {
  if (!isExternalRef(value))
    throw new DeskmatesError("validation", `${field} must be a printable provider id`, { field });
  return value;
}

/** The stored name: the provider's stem with the extension its type implies, so vision applies. */
function imageName(image: ChannelInboundImage, index: number): string {
  const extension = EXTENSION_BY_TYPE[image.mimeType] ?? "";
  const stem = image.name.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim() || `image-${index + 1}`;
  return `${stem}${extension}`;
}

interface Issued {
  token: symbol;
  endings: Set<() => void>;
}

export class ConnectionHosts {
  private readonly issued = new Map<string, Issued>();

  constructor(private readonly deps: ConnectionHostDeps) {}

  /** Make every host of `connectionId` stale and end its subscriptions. */
  revoke(connectionId: string): void {
    const current = this.issued.get(connectionId);
    this.issued.delete(connectionId);
    for (const end of current?.endings ?? []) end();
  }

  /** A host for the connection as stored now; every earlier host of it becomes stale. */
  issue(
    connection: StoredChannelConnection,
    admission: ChannelSenderAdmission = { mode: "blocklist" },
  ): ChannelConnectionHost {
    this.revoke(connection.id);
    const own: Issued = { token: Symbol(connection.id), endings: new Set() };
    this.issued.set(connection.id, own);
    const { deps } = this;
    const id = connection.id;
    const workspaceId = connection.workspaceId;
    const botId = connection.botId;
    const generation = connection.bindingGeneration;
    const channel = connection.pluginId;
    const keyPrefix = `${id}:${generation}:`;
    const ownThreads = new Map<string, boolean>();

    const inTrash = deps.db.prepare(
      "SELECT 1 FROM workspaces WHERE id = ? AND archived_at IS NOT NULL",
    );
    const live = (): StoredChannelConnection => {
      if (this.issued.get(id) !== own) throw stale(id);
      const row = deps.store.get(id);
      if (!row || row.bindingGeneration !== generation || row.botId !== botId) throw stale(id);
      // The workspace is marked archived before its connections are stopped (ADR-0026 decision
      // 2); nothing is admitted or sent in between.
      if (inTrash.get(workspaceId) !== undefined) throw archived(id);
      return row;
    };
    /** Whether the sender may write now, under the connection's current config and blocklist. */
    const admitted = (row: StoredChannelConnection, senderId: string): boolean =>
      admission.mode === "allowlist"
        ? parseChannelSenderList(row.config[admission.field]).has(senderId)
        : !deps.blocks.isBlocked(id, senderId);
    /** Why nothing may be sent to the thread's person, or nothing. */
    const sendRefusal = (row: StoredChannelConnection, threadId: string): string | undefined => {
      if (admission.mode === "blocklist")
        return deps.blocks.threadBlocked(id, channel, threadId) ? "sender_blocked" : undefined;
      const prefix = channelAuthorId(channel, "");
      const senders = (
        deps.db
          .prepare(
            `SELECT DISTINCT author_id FROM thread_messages
              WHERE thread_id = ? AND author_kind = 'human' AND substr(author_id, 1, ?) = ?`,
          )
          .all(threadId, prefix.length, prefix) as { author_id: string }[]
      ).map((item) => item.author_id.slice(prefix.length));
      // ADR-0017 decision 4: a person no longer listed receives nothing further.
      const listed = parseChannelSenderList(row.config[admission.field]);
      return senders.length > 0 && senders.every((sender) => listed.has(sender))
        ? undefined
        : "sender_not_listed";
    };
    const isOwn = (thread: Thread | undefined): thread is Thread =>
      thread !== undefined &&
      thread.workspaceId === workspaceId &&
      thread.channel === channel &&
      thread.channelConnectionId === id &&
      thread.bindingGeneration === generation;
    const ownThread = (threadId: unknown): Thread => {
      if (typeof threadId !== "string") throw notOwn();
      const thread = deps.threads.get(threadId as ThreadId);
      if (!isOwn(thread)) throw notOwn();
      return thread;
    };
    const keyOf = (conversationKey: unknown): string => {
      const key = `${keyPrefix}${ref(conversationKey, "conversationKey")}`;
      return ref(key, "conversationKey");
    };
    const findByKey = (key: string): Thread | undefined => {
      const row = deps.db
        .prepare(
          `SELECT id FROM threads WHERE workspace_id = ? AND channel = ? AND external_key = ?
             AND channel_connection_id = ? AND binding_generation = ?`,
        )
        .get(workspaceId, channel, key, id, generation) as { id: string } | undefined;
      return row ? deps.threads.get(row.id as ThreadId) : undefined;
    };
    /** Whether this conversation had a thread under an earlier generation of the connection. */
    const hadEarlierThread = (conversationKey: string): boolean => {
      if (generation <= 1) return false;
      const keys = Array.from(
        { length: generation - 1 },
        (_, n) => `${id}:${n + 1}:${conversationKey}`,
      );
      return (
        deps.db
          .prepare(
            `SELECT 1 FROM threads WHERE workspace_id = ? AND channel = ?
               AND external_key IN (${keys.map(() => "?").join(", ")})`,
          )
          .get(workspaceId, channel, ...keys) !== undefined
      );
    };
    const resolveThread = (
      conversationKey: string,
      title: string,
    ): { thread: Thread; notice?: ThreadMessage } => {
      const key = keyOf(conversationKey);
      const existing = findByKey(key);
      if (existing) return { thread: existing };
      const rebound = hadEarlierThread(conversationKey);
      let created: { thread: Thread; notice?: ThreadMessage };
      try {
        created = deps.db.transaction(() => {
          const thread = deps.threads.create({
            workspaceId,
            botIds: [botId],
            channel,
            externalKey: key,
            title,
            channelConnection: { id, bindingGeneration: generation },
          });
          if (!rebound) return { thread };
          // ADR-0047 decision 8: once per conversation and rebind, ahead of the first reply.
          const bot = deps.bots.get(botId);
          const notice = deps.messages.append({
            threadId: thread.id,
            authorKind: "system",
            authorId: "",
            body: channelRebindNotice(bot?.name ?? "a new assistant"),
            relayCount: 0,
          });
          return { thread, notice };
        })();
      } catch (error) {
        // Two deliveries of one new conversation raced; the other created it.
        const raced = findByKey(key);
        if (raced) return { thread: raced };
        throw error;
      }
      deps.bus.publish({ type: "thread_members", threadId: created.thread.id });
      if (created.notice)
        deps.bus.publish({
          type: "thread_message",
          threadId: created.thread.id,
          message: created.notice,
        });
      return created;
    };
    const duplicateOf = (
      externalId: string,
    ): { threadId: string; messageId: string } | undefined => {
      const row = deps.db
        .prepare(
          `SELECT m.id, m.thread_id FROM threads t JOIN thread_messages m ON m.thread_id = t.id
            WHERE t.channel_connection_id = ? AND m.external_id = ? LIMIT 1`,
        )
        .get(id, externalId) as { id: string; thread_id: string } | undefined;
      return row ? { threadId: row.thread_id, messageId: row.id } : undefined;
    };
    const storeImages = async (
      input: ChannelInboundMessage,
      authorId: string,
    ): Promise<{ attachments: Attachment[]; refused: number }> => {
      const images = input.images ?? [];
      const attachments: Attachment[] = [];
      let refused = 0;
      const store = deps.storeImage();
      for (const [index, image] of images.entries()) {
        const acceptable =
          index < CHANNEL_INBOUND_IMAGES_MAX &&
          store !== undefined &&
          CHANNEL_INBOUND_IMAGE_TYPES.includes(image.mimeType) &&
          image.bytes.byteLength > 0 &&
          image.bytes.byteLength <= CHANNEL_INBOUND_IMAGE_MAX_BYTES;
        if (!acceptable) {
          refused += 1;
          continue;
        }
        const idempotencyKey = `channel-image:${createHash("sha256")
          .update(`${id}\n${input.externalId}\n${index}`)
          .digest("hex")
          .slice(0, 48)}`;
        try {
          attachments.push(
            await store({
              workspaceId,
              uploader: authorId,
              name: imageName(image, index),
              bytes: image.bytes,
              idempotencyKey,
            }),
          );
        } catch (error) {
          refused += 1;
          deps.log("warn", "channel image not stored", {
            connectionId: id,
            reason: error instanceof DeskmatesError ? error.code : "internal",
          });
        }
      }
      return { attachments, refused };
    };
    const messageAt = (threadId: string, seq: number) =>
      deps.db
        .prepare(
          "SELECT author_kind, author_id FROM thread_messages WHERE thread_id = ? AND seq = ?",
        )
        .get(threadId, seq) as { author_kind: string; author_id: string } | undefined;
    const isSenderMessage = (row: { author_kind: string; author_id: string }) =>
      row.author_kind === "human" && row.author_id.startsWith(channelAuthorId(channel, ""));
    const scope = () => {
      const row = live();
      return {
        workspaceId,
        connectionId: id,
        bindingGeneration: generation,
        credentialGeneration: row.credentialGeneration,
      };
    };

    return {
      connectionId: id,
      workspaceId,
      botId,
      bindingGeneration: generation,
      channel,
      receive: async (input): Promise<ChannelInboundResult> => {
        const row = live();
        const conversationKey = ref(input?.conversationKey, "conversationKey");
        const senderId = ref(input.senderId, "senderId");
        const externalId = ref(input.externalId, "externalId");
        if (typeof input.body !== "string")
          throw new DeskmatesError("validation", "body must be text", { field: "body" });
        if (!admitted(row, senderId)) {
          deps.log("info", "channel sender not admitted; message dropped", {
            connectionId: id,
            admission: admission.mode,
          });
          return { status: "blocked" };
        }
        const duplicate = duplicateOf(externalId);
        if (duplicate) return { status: "duplicate", ...duplicate };
        const authorId = channelAuthorId(channel, senderId);
        const { attachments, refused } = await storeImages(input, authorId);
        // Storing images awaited; the fence may have moved meanwhile.
        live();
        if (input.body.trim() === "" && attachments.length === 0)
          return { status: "empty", imagesRefused: refused };
        const tenantId = deps.ownership.tenantOf("workspace", workspaceId);
        if (tenantId) deps.quotas.assertQueueRoom(tenantId);
        const { thread } = resolveThread(
          conversationKey,
          input.title?.trim() || `${channel} ${senderId}`,
        );
        const result = deps.router.postHuman({
          threadId: thread.id,
          body: input.body,
          authorId,
          externalId,
          fixedMembers: true,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        if (result.duplicate)
          return { status: "duplicate", threadId: thread.id, messageId: result.message.id };
        deps.bus.publish({ type: "thread_message", threadId: thread.id, message: result.message });
        for (const run of result.runs)
          deps.bus.publish({ type: "run_status", threadId: thread.id, run });
        deps.kick();
        return {
          status: "posted",
          thread: deps.threads.mustGet(thread.id),
          message: result.message,
          runs: result.runs,
          imagesRefused: refused,
        };
      },
      findThread: async (conversationKey) => {
        live();
        return findByKey(keyOf(conversationKey));
      },
      conversationKeyOf: async (threadId) => {
        live();
        const thread = ownThread(threadId);
        return (thread.externalKey ?? "").slice(keyPrefix.length);
      },
      getThread: async (threadId) => {
        live();
        const thread = ownThread(threadId);
        return { thread, members: deps.threads.members(thread.id) };
      },
      listMessages: async (threadId, afterSeq) => {
        live();
        const thread = ownThread(threadId);
        return deps.messages.list(thread.id, afterSeq);
      },
      listThreads: async () => {
        live();
        return (
          deps.db
            .prepare(
              "SELECT id FROM threads WHERE workspace_id = ? AND channel_connection_id = ? AND binding_generation = ? ORDER BY id",
            )
            .all(workspaceId, id, generation) as { id: string }[]
        ).map((row) => row.id);
      },
      syncActivity: async (threadId) => {
        live();
        const thread = ownThread(threadId);
        return syncConversationActivity(deps.db, deps.messages, deps.bus, thread.id);
      },
      getApproval: async (approvalId) => {
        live();
        const approval = deps.approvals.get(approvalId as ApprovalId);
        if (!approval?.threadId || !isOwn(deps.threads.get(approval.threadId))) return undefined;
        return approval;
      },
      decideApproval: async (input) => {
        const row = live();
        const approval = deps.approvals.get(input.id as ApprovalId);
        if (!approval?.threadId || !isOwn(deps.threads.get(approval.threadId)))
          throw new DeskmatesError("not_found", "approval not found");
        if (input.decision !== "allow_once" && input.decision !== "deny")
          throw new DeskmatesError("validation", "a channel decides only allow_once or deny");
        const senderId = ref(input.senderId, "senderId");
        const authorId = channelAuthorId(channel, senderId);
        const wrote =
          deps.db
            .prepare(
              `SELECT 1 FROM thread_messages WHERE thread_id = ? AND author_kind = 'human'
                 AND author_id = ? LIMIT 1`,
            )
            .get(approval.threadId, authorId) !== undefined;
        if (!wrote || !admitted(row, senderId))
          throw new DeskmatesError("forbidden", "only the conversation's own person decides here");
        const result = deps.broker.decide(
          approval.id,
          input.decision,
          decidedByHuman(authorId),
          input.reason,
        );
        deps.kick();
        return result.approval;
      },
      beginSend: async (input): Promise<ChannelSendPermit> => {
        const receiptScope = scope();
        const thread = ownThread(input.threadId);
        const message = messageAt(thread.id, input.seq);
        if (!message) throw new DeskmatesError("not_found", "message not found");
        if (isSenderMessage(message)) return { send: false, reason: "sender_message" };
        const receipt = deps.receipts.get(thread.id, input.seq);
        if (receipt?.state === "sent") return { send: false, reason: "already_sent" };
        if (receipt) return { send: false, reason: receipt.state };
        const refusal = sendRefusal(live(), thread.id);
        if (refusal) {
          deps.receipts.record(receiptScope, {
            threadId: thread.id,
            seq: input.seq,
            state: "blocked",
            reason: refusal,
          });
          return { send: false, reason: "blocked" };
        }
        return { send: true };
      },
      recordSend: async (input) => {
        const receiptScope = scope();
        const thread = ownThread(input.threadId);
        if (!messageAt(thread.id, input.seq))
          throw new DeskmatesError("not_found", "message not found");
        const ids = Array.isArray(input.providerMessageIds) ? input.providerMessageIds : [];
        const last = ids.at(-1);
        const receipt = deps.receipts.record(receiptScope, {
          threadId: thread.id,
          seq: input.seq,
          state: "sent",
          ...(typeof last === "string" && isExternalRef(last) ? { providerMessageId: last } : {}),
          chunkCount: ids.length,
        });
        if (receipt.state !== "sent")
          deps.log("warn", "channel send recorded after its message was fenced", {
            connectionId: id,
            state: receipt.state,
          });
      },
      subscribe: async (handlers, signal) => {
        live();
        await new Promise<void>((done, reject) => {
          let unsubscribe = (): void => {};
          const end = (): void => {
            unsubscribe();
            signal.removeEventListener("abort", end);
            own.endings.delete(end);
            done();
          };
          own.endings.add(end);
          unsubscribe = deps.bus.subscribe((event) => {
            if (this.issued.get(id) !== own) return end();
            const threadId = (event as { threadId?: unknown }).threadId;
            if (typeof threadId !== "string") return;
            let mine = ownThreads.get(threadId);
            if (mine === undefined) {
              mine = isOwn(deps.threads.get(threadId as ThreadId));
              ownThreads.set(threadId, mine);
            }
            if (mine) void handlers.onFrame(event as Parameters<typeof handlers.onFrame>[0]);
          });
          if (signal.aborted) end();
          else {
            signal.addEventListener("abort", end, { once: true });
            Promise.resolve()
              .then(() => handlers.onOpen())
              .catch((error: unknown) => {
                unsubscribe();
                signal.removeEventListener("abort", end);
                own.endings.delete(end);
                reject(error);
              });
          }
        });
      },
      admits: async (senderId) => admitted(live(), ref(senderId, "senderId")),
      claimIdentity: async (identity) => {
        live();
        if (!isChannelIdentityKey(identity?.identityKey, channel))
          throw new DeskmatesError("validation", "the channel plugin claimed no valid identity", {
            reason: "channel_identity_invalid",
          });
        const label =
          typeof identity.label === "string" && identity.label.trim()
            ? identity.label.trim().slice(0, CHANNEL_IDENTITY_LABEL_MAX)
            : identity.identityKey;
        const claimed = deps.store.claimIdentity(id, channel, {
          identityKey: identity.identityKey,
          label,
        });
        deps.log("info", "channel identity claimed", {
          connectionId: id,
          identityKey: claimed.identityKey,
        });
      },
      log: (level, message, data) =>
        deps.log(level, message, { ...(data ?? {}), connectionId: id }),
    };
  }
}
