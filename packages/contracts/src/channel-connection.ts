// ChannelPlugin ABI 2 (ADR-0047): one connection is one verified external identity bound to one
// Bot, and the Gateway hands the plugin a host scoped to that connection and its binding
// generation. ABI 1 (`channel.ts`) stays accepted unchanged for WhatsApp until its own change.
//
// The contract in one paragraph, for a provider plugin author:
// - The Gateway owns the lifecycle. It calls `verify` with the operator's input before anything is
//   stored; the plugin asks the provider who the credential belongs to and returns an
//   `identityKey`. The Gateway refuses a key already connected anywhere in the installation
//   (`channel_identity_in_use`), stores the connection, then calls `open` with a
//   `ChannelConnectionHost`. Reconnect, rebind and relink are `close` followed by `open` with a new
//   host; disconnect is `close(id, "disconnect")`. A plugin never decides which Bot, workspace or
//   generation it serves.
// - Every host call checks that the connection still exists, the binding generation is current
//   and this host is the connection's latest. Otherwise it throws `channel_connection_stale` and
//   has no effect: no thread, message, run, decision, receipt or send permit.
// - Inbound: one call, `receive`. The host resolves or creates the conversation's one-member
//   thread for the bound Bot, applies the connection's blocklist, deduplicates by the provider's
//   message id across every generation of the connection, stores images as workspace uploads and
//   posts the message. Only 1:1 conversations exist in this version; there is no group shape.
// - Outbound: subscribe for `thread_message` frames (only this connection's threads arrive), read
//   with `listMessages`, and relay every message whose author is not the sender itself (bot
//   replies and `system` notices, including the rebind notice). Before each provider send call
//   `beginSend`; send only when it answers `send: true`, and after the provider's receipt call
//   `recordSend`. A `cancelled` or `blocked` answer means advance past that message for good.
// - Approvals from the provider use ADR-0017 decision 7's text grammar; `decideApproval` decides
//   only approvals of this connection's current threads, for a sender who wrote in that thread.
// - Capabilities: declare every row of `ChannelCapabilityMatrix`. Refuse what is not `available`
//   with a visible notice to the person; never simulate it.
// - Third-party provider SDKs are imported only through `packages/channels/src/
//   provider-dependencies.ts`, lazily (ADR-0047 decision 15). The Gateway calls `create` only when
//   a connection of the plugin is first verified, opened or restored.
// - Two extensions of ADR-0047 amendment 1 (WhatsApp's move to ABI 2): a method whose identity is
//   known only after the person links (a QR scan) declares `identity: "link"`; the Gateway then
//   stores the connection under a pending key and the plugin names the identity with
//   `host.claimIdentity` once it is known. A plugin declares `senderAdmission`: `blocklist`, the
//   default (decision 13), or `allowlist` (ADR-0017 decision 4's deny-by-default list held in one
//   config field); the host enforces either in both directions, and `host.admits` answers before a
//   plugin sends a notice to a person.

import type { Approval, ApprovalDecision } from "./approval.js";
import type {
  ChannelMenuCommand,
  ChannelMenuRequest,
  ChannelMenuResult,
} from "./channel-command-menu.js";
import { channelSetupProblems } from "./channel-setup-guide.js";
import type {
  ChannelConfigField,
  ChannelConnectionMethod,
  ChannelConnectionStatus,
  ChannelWebhookRequest,
  ChannelWebhookResponse,
} from "./channel.js";
import type { BotId, WorkspaceId } from "./ids.js";
import type { Run, RunStatus } from "./run.js";
import type { Thread, ThreadMember, ThreadMessage } from "./thread.js";

/** The connection-scoped ABI (ADR-0047 decision 9). */
export const CHANNEL_PLUGIN_API_VERSION_2 = 2 as const;

/** Every plugin ABI this Gateway release loads: 1 (plugin-wide host) and 2. */
export const SUPPORTED_CHANNEL_PLUGIN_API_VERSIONS: readonly number[] = [1, 2];

/**
 * `available`: on in this version. `disabled`: the provider supports it but this version keeps it
 * off. `unavailable`: not supported, not verified, or not implemented in this version.
 */
export type ChannelCapabilityState = "available" | "disabled" | "unavailable";

export const CHANNEL_CAPABILITY_STATES: readonly ChannelCapabilityState[] = [
  "available",
  "disabled",
  "unavailable",
];

/** One row per capability of ADR-0047 decision 12. Every ABI-2 manifest declares all of them. */
export interface ChannelCapabilityMatrix {
  /** 1:1 conversations with a person. */
  directMessages: ChannelCapabilityState;
  /**
   * Groups, channels, threads and topics. Not implemented in this version (owner ruling
   * 2026-10-17): group support is a later design, so the type admits only `unavailable`.
   */
  groups: "unavailable";
  /** Images a person sends; they enter the workspace like a Web upload (`ChannelInboundImage`). */
  inboundImages: ChannelCapabilityState;
  /** Voice, video, documents, stickers, locations: `disabled` with a refusal notice in v1. */
  inboundOtherMedia: ChannelCapabilityState;
  /** Text replies in a conversation the person started. */
  outboundReply: ChannelCapabilityState;
  /** A send that is not a reply. Reply-only (`unavailable`) wherever unverified. */
  proactiveMessages: ChannelCapabilityState;
  /** Streaming or edit-in-place progress. */
  streaming: ChannelCapabilityState;
  /** Approval decisions from the provider in ADR-0017 decision 7's grammar. */
  approvals: ChannelCapabilityState;
  /** The Integrations page's test message. */
  testMessage: ChannelCapabilityState;
}

export const CHANNEL_CAPABILITY_ROWS = [
  "directMessages",
  "groups",
  "inboundImages",
  "inboundOtherMedia",
  "outboundReply",
  "proactiveMessages",
  "streaming",
  "approvals",
  "testMessage",
] as const satisfies readonly (keyof ChannelCapabilityMatrix)[];

/**
 * How a connection's identity becomes known (ADR-0047 amendment 1). `verify`, the default: the
 * Gateway calls `verify` before anything is stored. `link`: only after the person links the
 * account (a QR scan); the Gateway stores the connection under a pending key and the plugin calls
 * `host.claimIdentity` once the provider names the account.
 */
export type ChannelIdentitySource = "verify" | "link";

export interface ChannelConnectionMethodV2 extends ChannelConnectionMethod {
  identity?: ChannelIdentitySource;
}

/**
 * Who may write to a connection (ADR-0047 decision 13 and amendment 1). `blocklist`, the default:
 * every sender unless on the connection's blocklist. `allowlist`: nobody unless listed in the
 * connection's config field `field` (comma-separated provider sender ids, ADR-0017 decision 4).
 * The host applies either to inbound, approvals and every send.
 */
export type ChannelSenderAdmission = { mode: "blocklist" } | { mode: "allowlist"; field: string };

export interface ChannelPluginManifestV2 {
  apiVersion: typeof CHANNEL_PLUGIN_API_VERSION_2;
  /** The plugin id is also the thread channel name and the first segment of every identity key. */
  id: string;
  version: string;
  displayName: string;
  description: string;
  /**
   * Whether one workspace may hold several connections of this plugin, each its own external
   * identity and Bot (ADR-0047 decision 7). Without it the workspace holds at most one.
   */
  multipleConnections: boolean;
  commandMenu?: readonly ChannelMenuCommand[];
  capabilities: ChannelCapabilityMatrix;
  methods: readonly ChannelConnectionMethodV2[];
  /** Stable provider-defined phases whose labels are safe to show to an operator. */
  statusVocabulary: readonly string[];
  /** Absent means `{ mode: "blocklist" }` (ADR-0047 decision 13). */
  senderAdmission?: ChannelSenderAdmission;
}

/** The admission a manifest declares, with the default filled in. */
export function channelSenderAdmission(
  manifest: Pick<ChannelPluginManifestV2, "senderAdmission">,
): ChannelSenderAdmission {
  return manifest.senderAdmission ?? { mode: "blocklist" };
}

/**
 * An allowlist field's value as a set of provider sender ids: comma-separated, trimmed, a leading
 * `+` dropped, empty entries ignored. An empty or missing value admits nobody.
 */
export function parseChannelSenderList(value: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof value !== "string") return out;
  for (const entry of value.split(",")) {
    const id = entry.trim().replace(/^\+/, "");
    if (id !== "") out.add(id);
  }
  return out;
}

/**
 * The verified identity of a connection (ADR-0047 decision 6): `<plugin id>:<namespace>:<id>`,
 * from the provider's own identity call, never from what the operator typed. It holds no
 * credential material. `label` is a display name, not part of the key.
 */
export interface ChannelIdentity {
  identityKey: string;
  label: string;
}

/** `<plugin id>:<namespace>:<id>`: printable, no spaces, at most 200 characters. */
export const CHANNEL_IDENTITY_KEY_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._:@+-]{1,100}$/;

export function isChannelIdentityKey(value: unknown, pluginId?: string): value is string {
  if (typeof value !== "string" || !CHANNEL_IDENTITY_KEY_PATTERN.test(value)) return false;
  if (value.split(":")[1] === CHANNEL_PENDING_IDENTITY_NAMESPACE) return false;
  return pluginId === undefined || value.startsWith(`${pluginId}:`);
}

/** The namespace of a pending identity key; reserved, so no plugin may return it. */
export const CHANNEL_PENDING_IDENTITY_NAMESPACE = "pending";

/**
 * The key a `link` connection holds until its plugin claims the real identity: unique per
 * connection, never shown as an identity, never a valid `identityKey` (ADR-0047 amendment 1).
 */
export function channelPendingIdentityKey(pluginId: string, connectionId: string): string {
  return `${pluginId}:${CHANNEL_PENDING_IDENTITY_NAMESPACE}:${connectionId}`;
}

export function isPendingChannelIdentityKey(value: unknown): boolean {
  return typeof value === "string" && value.split(":")[1] === CHANNEL_PENDING_IDENTITY_NAMESPACE;
}

/** Longest identity label shown to an operator. */
export const CHANNEL_IDENTITY_LABEL_MAX = 120;

/** What `verify` receives: the operator's input, nothing stored yet. */
export interface ChannelVerifyRequest {
  workspaceId: WorkspaceId;
  method: string;
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
}

/** Why `open` is called. A plugin may keep a provider cursor across `reconnect` and `restore`. */
export type ChannelOpenReason = "connect" | "restore" | "reconnect" | "rebind" | "relink";

export interface ChannelOpenRequest {
  connectionId: string;
  workspaceId: WorkspaceId;
  botId: BotId;
  identityKey: string;
  /** Increments on every rebind; the host refuses calls of an older one. */
  bindingGeneration: number;
  /**
   * Increments on every relink (credential change for the same identity). A plugin discards reply
   * contexts and send receipts of an older credential generation (ADR-0047 decision 8).
   */
  credentialGeneration: number;
  reason: ChannelOpenReason;
  method: string;
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  /** Absolute private operator path owned by this connection (0700). */
  stateDirectory: string;
}

/**
 * Why `close` is called. `disconnect` is final (log out where the provider has a session).
 * `archive` stops the connection because its workspace moved to Trash: keep the private state and
 * the provider link (no logout); `open` with reason `restore` follows only if the workspace is
 * restored (ADR-0017 amendment 1 P6). The others are followed by `open` with a new host.
 */
export type ChannelCloseReason = "disconnect" | "archive" | "reconnect" | "rebind" | "relink";

/** An image a person sent (ADR-0047 decision 12). The host stores it like a Web upload. */
export interface ChannelInboundImage {
  /** The provider's file name, or one the plugin makes up; sanitized by the host. */
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Image types the host stores; others are refused like other media. */
export const CHANNEL_INBOUND_IMAGE_TYPES: readonly string[] = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
];

/** Largest inbound image the host stores, in bytes. */
export const CHANNEL_INBOUND_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** At most this many images per inbound message; the rest are refused. */
export const CHANNEL_INBOUND_IMAGES_MAX = 4;

/** One admitted-or-not inbound message of a 1:1 conversation. */
export interface ChannelInboundMessage {
  /**
   * The provider's id for the 1:1 conversation (a chat id, a DM channel id). The host prefixes it
   * with the connection id and generation; the plugin never sees another connection's keys.
   */
  conversationKey: string;
  /** The provider's id for the person. Blocklist entries and `authorId` use it. */
  senderId: string;
  /** The provider's id for this message or event; a redelivery returns `duplicate`. */
  externalId: string;
  /** The text; may be empty when images carry the message. */
  body: string;
  /** Title of a newly created thread; defaults to `<display name> <senderId>`. */
  title?: string;
  images?: readonly ChannelInboundImage[];
}

export type ChannelInboundResult =
  | {
      status: "posted";
      thread: Thread;
      message: ThreadMessage;
      runs: Run[];
      /** Images not stored (type, size, count, or the workspace not running); tell the person. */
      imagesRefused: number;
    }
  /** Already posted under this connection; nothing new was created. */
  | { status: "duplicate"; threadId: string; messageId: string }
  /** The sender is on the connection's blocklist: acknowledge the provider and drop it. */
  | { status: "blocked" }
  /** No text and no image could be stored: nothing was posted; tell the person. */
  | { status: "empty"; imagesRefused: number };

/** The answer of the send gate (ADR-0047 decision 9). */
export type ChannelSendPermit =
  | { send: true }
  /**
   * Never send this message; advance past it. `cancelled`: fenced by a rebind or disconnect.
   * `blocked`: the person is on the blocklist. `sender_message`: the person's own message.
   * `already_sent`: a send was recorded for it (a plugin restarted between send and cursor).
   */
  | { send: false; reason: "cancelled" | "blocked" | "sender_message" | "already_sent" };

export type ChannelConnectionFrame =
  | { type: "thread_message"; threadId: string; message: ThreadMessage }
  | { type: string; threadId: string };

/** The only Gateway services an ABI-2 plugin uses, all scoped to one connection and generation. */
export interface ChannelConnectionHost {
  readonly connectionId: string;
  readonly workspaceId: WorkspaceId;
  readonly botId: BotId;
  readonly bindingGeneration: number;
  /** The thread channel name: the plugin id. */
  readonly channel: string;
  /** Admit, deduplicate, store images and post one inbound message (see the file comment). */
  receive(input: ChannelInboundMessage): Promise<ChannelInboundResult>;
  /** The current generation's thread of a conversation, if one exists. */
  findThread(conversationKey: string): Promise<Thread | undefined>;
  /** The provider conversation key of one of this connection's threads. */
  conversationKeyOf(threadId: string): Promise<string>;
  getThread(threadId: string): Promise<{
    thread: Thread;
    members: (ThreadMember & { name: string })[];
  }>;
  listMessages(threadId: string, afterSeq: number): Promise<ThreadMessage[]>;
  /** Current binding only; recovery discovers conversations even if a local cursor was lost. */
  listThreads?(): Promise<string[]>;
  /** Snapshot current activity and persist deduplicated system notices; never wakes a bot. */
  syncActivity?(threadId: string): Promise<{ runId: string; status: RunStatus } | undefined>;
  getApproval(id: string): Promise<Approval | undefined>;
  decideApproval(input: {
    id: string;
    decision: Extract<ApprovalDecision, "allow_once" | "deny">;
    /** The deciding person's provider id; they must have written in the approval's thread. */
    senderId: string;
    reason?: string;
  }): Promise<Approval>;
  /** Ask before each provider send of message `seq` in `threadId`. */
  beginSend(input: { threadId: string; seq: number }): Promise<ChannelSendPermit>;
  /** Record a send the provider acknowledged; ids are the provider's message ids, one per chunk. */
  recordSend(input: {
    threadId: string;
    seq: number;
    providerMessageIds: readonly string[];
  }): Promise<void>;
  /** Frames of this connection's current threads only; ends when the handle goes stale. */
  subscribe(
    handlers: {
      onFrame(frame: ChannelConnectionFrame): void | Promise<void>;
      onOpen(): void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Whether `senderId` may write to this connection now (its admission mode, ADR-0047 amendment
   * 1). Ask before sending a notice to a person that `receive` would not see, such as a media
   * refusal. The Gateway's host always provides it; optional only so hosts written before it
   * still type-check.
   */
  admits?(senderId: string): Promise<boolean>;
  /**
   * Name the connection's identity once the provider reveals it, for a `link` method (ADR-0047
   * amendment 1). The first claim of a pending connection stores it, unless another connection
   * holds it (`channel_identity_in_use`); a later claim must equal it
   * (`channel_identity_mismatch`). The plugin stops serving the account on either refusal. The
   * Gateway's host always provides it.
   */
  claimIdentity?(identity: ChannelIdentity): Promise<void>;
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface ChannelPluginContextV2 {
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface ChannelPluginRuntimeV2 {
  commandMenu?(connectionId: string, input: ChannelMenuRequest): Promise<ChannelMenuResult>;
  /** Ask the provider who the credential belongs to; throw when it is refused. */
  verify(request: ChannelVerifyRequest): Promise<ChannelIdentity>;
  open(request: ChannelOpenRequest, host: ChannelConnectionHost): Promise<ChannelConnectionStatus>;
  close(connectionId: string, reason: ChannelCloseReason): Promise<void>;
  status(connectionId: string): Promise<ChannelConnectionStatus>;
  /** The Integrations test message, only when `capabilities.testMessage` is `available`. */
  test(
    connectionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<ChannelConnectionStatus>;
  /** Signed provider ingress for `connectionId`; verify the signature before any host call. */
  webhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse>;
  /** Stop every live connection while retaining its private state. */
  stop(): Promise<void>;
}

export interface ChannelPluginV2 {
  manifest: ChannelPluginManifestV2;
  create(context: ChannelPluginContextV2): Promise<ChannelPluginRuntimeV2>;
}

/** Shape exported by a release-bundled ABI-2 plugin entry point. */
export interface ChannelPluginModuleV2 {
  channelPlugin: ChannelPluginV2;
}

/** The fixed rebind notice (ADR-0047 decision 8), appended once per conversation and rebind. */
export function channelRebindNotice(botName: string): string {
  return `This conversation is now handled by ${botName}. Earlier messages stay with the previous assistant and are not carried over.`;
}

function isText(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/**
 * Why an exported ABI-2 manifest is not loadable, or nothing. The loader refuses a plugin with
 * any problem, so a manifest that omits a capability row or declares groups is never offered.
 */
export function channelManifestV2Problems(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return ["manifest is not an object"];
  const m = manifest as Partial<Record<keyof ChannelPluginManifestV2, unknown>>;
  const problems: string[] = [];
  if (m.apiVersion !== CHANNEL_PLUGIN_API_VERSION_2) problems.push("apiVersion must be 2");
  if (typeof m.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(m.id))
    problems.push("id must be a channel name");
  for (const key of ["version", "displayName", "description"] as const)
    if (!isText(m[key])) problems.push(`${key} must be text`);
  if (typeof m.multipleConnections !== "boolean")
    problems.push("multipleConnections must be a boolean");
  if (
    m.commandMenu !== undefined &&
    (!Array.isArray(m.commandMenu) ||
      m.commandMenu.length > 100 ||
      m.commandMenu.some(
        (item: Partial<ChannelMenuCommand> | null) =>
          !item ||
          typeof item.command !== "string" ||
          !/^[a-z0-9_]{1,32}$/.test(item.command) ||
          !isText(item.description, 256),
      ) ||
      new Set(m.commandMenu.map((item: ChannelMenuCommand) => item.command)).size !==
        m.commandMenu.length)
  )
    problems.push("commandMenu must contain unique commands and descriptions");
  const capabilities = m.capabilities;
  if (!capabilities || typeof capabilities !== "object") problems.push("capabilities missing");
  else {
    const declared = capabilities as Record<string, unknown>;
    for (const row of CHANNEL_CAPABILITY_ROWS) {
      const state = declared[row];
      if (!CHANNEL_CAPABILITY_STATES.includes(state as ChannelCapabilityState))
        problems.push(`capability ${row} must be available, disabled or unavailable`);
    }
    if (declared.groups !== "unavailable")
      problems.push("capability groups must be unavailable in this version");
    for (const key of Object.keys(declared))
      if (!(CHANNEL_CAPABILITY_ROWS as readonly string[]).includes(key))
        problems.push(`unknown capability ${key}`);
  }
  if (!Array.isArray(m.methods) || m.methods.length === 0) problems.push("methods missing");
  else
    for (const method of m.methods as Partial<ChannelConnectionMethodV2>[])
      if (
        method?.identity !== undefined &&
        method.identity !== "verify" &&
        method.identity !== "link"
      )
        problems.push(`method ${String(method.id)} identity must be verify or link`);
  if (Array.isArray(m.methods))
    for (const method of m.methods as unknown[]) problems.push(...channelSetupProblems(method));
  if (!Array.isArray(m.statusVocabulary)) problems.push("statusVocabulary missing");
  const admission = m.senderAdmission as Partial<{ mode: string; field: unknown }> | undefined;
  if (admission !== undefined) {
    if (admission?.mode === "allowlist") {
      const field = admission.field;
      const declared = (method: { fields?: readonly ChannelConfigField[] }) =>
        method.fields?.some((item) => item.key === field && !item.secret) === true;
      if (
        typeof field !== "string" ||
        !Array.isArray(m.methods) ||
        !(m.methods as { fields?: readonly ChannelConfigField[] }[]).every(declared)
      )
        problems.push("senderAdmission allowlist must name a plain config field of every method");
    } else if (admission?.mode !== "blocklist")
      problems.push("senderAdmission mode must be blocklist or allowlist");
  }
  return problems;
}

/** One entry of a connection's sender blocklist (ADR-0047 decision 13). */
export interface ChannelSenderBlock {
  connectionId: string;
  /** The provider's id for the person, as `ChannelInboundMessage.senderId` carries it. */
  senderId: string;
  /** An operator's note; never sent anywhere. */
  note?: string;
  createdBy: string;
  createdAt: string;
}

/** Longest provider sender id a blocklist entry holds. */
export const CHANNEL_SENDER_ID_MAX = 128;
