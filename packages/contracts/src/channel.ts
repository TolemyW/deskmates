// Chat channels (ADR-0017). Official channel runtimes are release-bundled plugins behind this
// versioned, vendor-neutral contract. The first host is in-process; the request/response shapes
// deliberately contain no Fastify, database or provider types so the same interface can later be
// carried across a process boundary.

import type { Approval, ApprovalDecision } from "./approval.js";
import type { BotId, WorkspaceId } from "./ids.js";
import type { Run } from "./run.js";
import type { Thread, ThreadMember, ThreadMessage } from "./thread.js";

/** The operator UI's own channel; the default for `POST /api/threads`. */
export const WEB_CHANNEL = "web";

/** The WhatsApp Business Platform adapter in `packages/channels` (ADR-0017 decision 3). */
export const WHATSAPP_CHANNEL = "whatsapp";

/** A channel name: lower-case, starts with a letter, at most 32 characters. */
export const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isChannelName(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_NAME_PATTERN.test(value);
}

/**
 * Whether `thread` belongs to an external chat channel, so its Web view is a read-only mirror
 * (ADR-0017 amendment 2): the human converses on that channel, and the Gateway refuses a person's
 * or service principal's post to it. The operator UI's `web` threads and agent-client submission
 * threads (`agent:*`, not a channel name) stay writable.
 */
export function isChannelMirrorThread(thread: { channel: string }): boolean {
  return thread.channel !== WEB_CHANNEL && isChannelName(thread.channel);
}

/** Longest `externalKey` or `externalId` the Gateway stores. */
export const EXTERNAL_REF_MAX_LENGTH = 200;

/**
 * An adapter's identifier for a conversation (`externalKey`) or a message (`externalId`): printable,
 * non-empty, bounded. Opaque to the Gateway; it only compares them for equality.
 */
export function isExternalRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > EXTERNAL_REF_MAX_LENGTH) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what is refused
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/** A thread's binding to an external conversation (ADR-0017 decision 2). */
export interface ChannelThreadBinding {
  channel: string;
  externalKey: string;
}

/**
 * The `authorId` of a human message that arrived through a channel: `<channel>:<external user id>`
 * (ADR-0017 decision 4). The adapter uses it to tell its own sender's messages from everything
 * else it must relay.
 */
export function channelAuthorId(channel: string, externalUserId: string): string {
  return `${channel}:${externalUserId}`;
}

export function isChannelAuthorId(authorId: string, channel: string): boolean {
  return authorId.startsWith(`${channel}:`);
}

/** The only plugin ABI accepted by this Gateway release. */
export const CHANNEL_PLUGIN_API_VERSION = 1 as const;

export type ChannelConfigFieldKind = "text" | "password" | "select" | "bot" | "phone-list";

/** A small declarative schema rendered by the generic Integrations UI. */
export interface ChannelConfigField {
  key: string;
  label: string;
  kind: ChannelConfigFieldKind;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  options?: readonly { value: string; label: string }[];
}

export interface ChannelConnectionMethod {
  id: string;
  label: string;
  description: string;
  fields: readonly ChannelConfigField[];
}

export interface ChannelPluginManifest {
  apiVersion: typeof CHANNEL_PLUGIN_API_VERSION;
  id: string;
  version: string;
  displayName: string;
  description: string;
  capabilities: {
    directMessages: boolean;
    groups: boolean;
    testMessage: boolean;
  };
  methods: readonly ChannelConnectionMethod[];
  /** Stable provider-defined phases whose labels are safe to show to an operator. */
  statusVocabulary: readonly string[];
}

export interface ChannelConnectionStatus {
  phase: string;
  message?: string;
  account?: string;
  /** Short-lived data URL for a pairing code. Never persisted by the Gateway. */
  qr?: string;
  qrExpiresAt?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ChannelConnection {
  id: string;
  workspaceId: WorkspaceId;
  pluginId: string;
  pluginVersion: string;
  method: string;
  botId: BotId;
  config: Readonly<Record<string, unknown>>;
  status: ChannelConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelPostedMessage {
  message: ThreadMessage;
  runs: Run[];
  duplicate?: boolean;
}

export type ChannelHostFrame =
  | { type: "thread_message"; threadId: string; message: ThreadMessage }
  | { type: string; threadId?: string };

/** The transcript-facing services a plugin may use. No provider-specific operation is present. */
export interface ChannelPluginHost {
  findThread(
    workspaceId: WorkspaceId,
    channel: string,
    externalKey: string,
  ): Promise<Thread | undefined>;
  createThread(input: {
    workspaceId: WorkspaceId;
    botId: BotId;
    channel: string;
    externalKey: string;
    title: string;
  }): Promise<Thread>;
  getThread(id: string): Promise<{ thread: Thread; members: (ThreadMember & { name: string })[] }>;
  postHumanMessage(input: {
    threadId: string;
    body: string;
    authorId: string;
    externalId: string;
  }): Promise<ChannelPostedMessage>;
  listMessages(threadId: string, afterSeq: number): Promise<ThreadMessage[]>;
  getApproval(id: string): Promise<Approval | undefined>;
  decideApproval(input: {
    id: string;
    decision: Extract<ApprovalDecision, "allow_once" | "deny">;
    authorId: string;
    reason?: string;
  }): Promise<Approval>;
  subscribe(
    handlers: {
      onFrame(frame: ChannelHostFrame): void | Promise<void>;
      onOpen(): void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void>;
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface ChannelConnectRequest {
  connectionId: string;
  workspaceId: WorkspaceId;
  botId: BotId;
  method: string;
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  /** Absolute private operator path owned by this connection. */
  stateDirectory: string;
}

export type ChannelCommand = "reconnect" | "relink" | "test" | "disconnect";

export interface ChannelWebhookRequest {
  connectionId: string;
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}

export interface ChannelWebhookResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export interface ChannelPluginRuntime {
  connect(request: ChannelConnectRequest): Promise<ChannelConnectionStatus>;
  restore(request: ChannelConnectRequest): Promise<ChannelConnectionStatus>;
  status(connectionId: string): Promise<ChannelConnectionStatus>;
  command(
    connectionId: string,
    command: ChannelCommand,
    input?: Readonly<Record<string, unknown>>,
  ): Promise<ChannelConnectionStatus>;
  webhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse>;
  /** Stop every live connection while retaining its private state. */
  stop(): Promise<void>;
}

export interface ChannelPlugin {
  manifest: ChannelPluginManifest;
  create(host: ChannelPluginHost): Promise<ChannelPluginRuntime>;
}

/** Shape exported by a release-bundled plugin entry point. */
export interface ChannelPluginModule {
  channelPlugin: ChannelPlugin;
}
