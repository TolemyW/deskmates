// One live Discord connection: a Gateway websocket session for inbound direct messages, the REST
// API for replies, and the connection-scoped host for every Gateway service (ADR-0047 decision 9).
//
// Inbound: one direct message at a time, in order. Ignored (no host call): guild channels and
// threads, bots, webhooks, the bot itself, system messages. An approval command (ADR-0017
// decision 7) decides through the host and is never posted. Images are downloaded from Discord's
// CDN and handed to `host.receive`; other media is refused with a notice. A notice goes only to a
// sender the host admits: the plugin asks with an empty `receive`, which posts nothing and answers
// `blocked` for a sender on the connection's blocklist.
//
// Outbound: every `thread_message` frame of this connection's threads relays that thread through
// the send gate: `beginSend`, the chunks (2000 characters) as Discord messages, then `recordSend`
// with Discord's message ids. A transient failure keeps the message and retries with a growing
// delay; delivered chunks are remembered so a retry sends only the rest. Delivery is at least
// once: a crash between Discord's answer and the saved progress repeats a chunk.

import {
  CHANNEL_INBOUND_IMAGE_MAX_BYTES,
  type ChannelConnectionHost,
  type ChannelConnectionStatus,
  type ChannelInboundImage,
  type ChannelInboundMessage,
  type ChannelInboundResult,
  type ChannelOpenRequest,
  isDeskmatesError,
} from "@deskmates/contracts";
import { type ApprovalCommand, parseApprovalCommand } from "../whatsapp/commands.js";
import { DiscordGatewaySession, type DiscordReady } from "./gateway-session.js";
import { type DiscordInbound, classifyDiscordMessage } from "./inbound.js";
import type { DiscordPhase } from "./manifest.js";
import {
  APPROVAL_NOT_DECIDABLE_NOTICE,
  APPROVAL_REFUSED_NOTICE,
  APPROVAL_SETTLED_NOTICE,
  EMPTY_MESSAGE_NOTICE,
  OTHER_MEDIA_NOTICE,
  imagesRefusedNotice,
} from "./notices.js";
import { chunkDiscordText, renderDiscordMessage } from "./outbound.js";
import {
  DiscordHttpError,
  type DiscordMessage,
  DiscordRest,
  normalizeDiscordToken,
  redactToken,
} from "./rest.js";
import {
  type DiscordConnectionState,
  type DiscordThreadCursor,
  loadDiscordState,
  saveDiscordState,
} from "./state.js";
import type { DiscordTransport } from "./transport.js";

export interface DiscordTimings {
  /** Reconnect backoff of the Gateway websocket. */
  reconnect: { initialMs: number; maxMs: number };
  /** Retry backoff of a thread whose send failed transiently. */
  relayRetry: { initialMs: number; maxMs: number };
  /** Waits before retrying a failed `host.receive`; its length is the number of retries. */
  receiveRetryMs: readonly number[];
  /** How long `open` waits for READY before answering `connecting`. */
  openTimeoutMs: number;
  helloTimeoutMs: number;
  invalidSessionDelayMs?: () => number;
}

export const DISCORD_TIMINGS_DEFAULT: DiscordTimings = {
  reconnect: { initialMs: 1_000, maxMs: 60_000 },
  relayRetry: { initialMs: 2_000, maxMs: 60_000 },
  receiveRetryMs: [250, 1_000, 4_000],
  openTimeoutMs: 10_000,
  helloTimeoutMs: 30_000,
};

export interface DiscordConnectionOptions {
  request: ChannelOpenRequest;
  host: ChannelConnectionHost;
  transport: DiscordTransport;
  timings: DiscordTimings;
  /** Sleep used by REST retries. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Errors after which this connection's host will never answer again. */
const FINAL_HOST_CODES = new Set(["channel_connection_stale"]);
/** Host refusals that a retry cannot change. */
const PERMANENT_HOST_CODES = new Set([
  "channel_connection_stale",
  "validation",
  "forbidden",
  "not_found",
]);

/** The application id an identity key names: `discord:app:<id>`. */
export function applicationIdOf(identityKey: string): string {
  return identityKey.split(":").slice(2).join(":");
}

function snowflakeAfter(a: string, b: string | undefined): boolean {
  if (b === undefined) return true;
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
}

export class DiscordConnection {
  phase: DiscordPhase = "connecting";
  private message: string | undefined;
  private username: string | undefined;
  private state!: DiscordConnectionState;
  private readonly rest: DiscordRest;
  private session: DiscordGatewaySession | undefined;
  private readonly abort = new AbortController();
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  /** Set once closed: no more saves, sends or host calls. */
  private retired = false;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDelays = new Map<string, number>();
  private readyWaiters: (() => void)[] = [];
  readonly counters = {
    received: 0,
    duplicates: 0,
    blocked: 0,
    ignored: 0,
    refusedMedia: 0,
    sent: 0,
    sendFailures: 0,
    caughtUp: 0,
  };

  constructor(private readonly options: DiscordConnectionOptions) {
    this.rest = new DiscordRest({
      transport: options.transport,
      token: this.token,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  }

  private get token(): string {
    return normalizeDiscordToken(this.options.request.secrets.token);
  }

  private get host(): ChannelConnectionHost {
    return this.options.host;
  }

  private log(level: "info" | "warn", message: string, data?: Record<string, unknown>): void {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data ?? {}))
      safe[key] = typeof value === "string" ? redactToken(value, this.token) : value;
    try {
      this.host.log(level, redactToken(message, this.token), safe);
    } catch {
      // Logging must never break the connection.
    }
  }

  async open(): Promise<ChannelConnectionStatus> {
    const { request, timings } = this.options;
    this.state = await loadDiscordState(request.stateDirectory, request.credentialGeneration);
    // A concurrent replacement/stop may have retired this object during the state read.
    if (this.retired) return this.status();
    // Permanent partial refusals need an operator retry, not an automatic reconnect loop.
    if (request.reason === "reconnect")
      for (const cursor of Object.values(this.state.threads))
        if (cursor.pending?.failed)
          cursor.pending = { seq: cursor.pending.seq, chunkIds: cursor.pending.chunkIds };
    this.scheduleSave();
    this.session = new DiscordGatewaySession({
      transport: this.options.transport,
      token: this.token,
      resolveUrl: () => this.rest.gatewayUrl(),
      ...(this.state.resume ? { resume: this.state.resume } : {}),
      onReady: (ready) => this.onReady(ready),
      onDispatch: (type, data) => {
        if (type === "MESSAGE_CREATE") this.enqueueInbound(data as DiscordMessage, "gateway");
      },
      onResumeState: (resume) => {
        this.state.resume = resume ?? null;
        this.scheduleSave();
      },
      onReconnecting: () => {
        if (this.phase === "connected" || this.phase === "connecting") this.phase = "reconnecting";
      },
      onFatal: (kind, message) => this.fail(kind, message),
      log: (level, message, data) => this.log(level, message, data),
      backoff: timings.reconnect,
      helloTimeoutMs: timings.helloTimeoutMs,
      ...(timings.invalidSessionDelayMs
        ? { invalidSessionDelayMs: timings.invalidSessionDelayMs }
        : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
    });
    void this.host
      .subscribe(
        {
          onOpen: () => {
            for (const threadId of Object.keys(this.state.threads)) this.relay(threadId);
          },
          onFrame: (frame) => {
            if (frame.type === "thread_message") this.relay(frame.threadId);
          },
        },
        this.abort.signal,
      )
      .catch((error: unknown) => this.hostFailed(error));
    const settled = new Promise<void>((done) => {
      this.readyWaiters.push(done);
      setTimeout(done, timings.openTimeoutMs).unref?.();
    });
    this.session.start();
    await settled;
    return this.status();
  }

  status(): ChannelConnectionStatus {
    const partialReplies = Object.values(this.state?.threads ?? {}).filter(
      (cursor) => cursor.pending?.failed,
    ).length;
    const message =
      this.message ??
      (partialReplies > 0
        ? "A reply was partially delivered. Use Reconnect to retry the remaining chunks."
        : undefined);
    return {
      phase: this.phase,
      ...(message ? { message } : {}),
      ...(this.username ? { account: this.username } : {}),
      details: {
        identifies: this.session?.counters.identifies ?? 0,
        resumes: this.session?.counters.resumes ?? 0,
        reconnects: this.session?.counters.reconnects ?? 0,
        ...this.counters,
        partialReplies,
      },
    };
  }

  /** Stop the connection. `resumable` keeps the Discord session for the next `open`. */
  async close(resumable: boolean, keepState: boolean): Promise<void> {
    if (!keepState) this.retired = true;
    this.session?.stop(resumable);
    this.abort.abort();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.phase !== "revoked" && this.phase !== "failed") this.phase = "stopped";
    this.settleReady();
    if (keepState && this.state) {
      if (!resumable) this.state.resume = null;
      this.scheduleSave();
    }
    await this.saving;
    this.retired = true;
  }

  private settleReady(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const done of waiters) done();
  }

  private fail(kind: "revoked" | "failed", message: string): void {
    this.phase = kind;
    this.message = message;
    this.log("warn", "discord connection stopped", { reason: kind });
    this.session?.stop(false);
    this.settleReady();
  }

  private onReady(ready: DiscordReady): void {
    if (this.retired) return;
    if (!ready.resumed) {
      const expected = applicationIdOf(this.options.request.identityKey);
      if (ready.applicationId !== undefined && ready.applicationId !== expected) {
        this.fail("failed", "The bot token now belongs to a different Discord application.");
        return;
      }
      if (ready.userId) {
        this.state.botUserId = ready.userId;
        this.scheduleSave();
      }
      if (ready.username) this.username = ready.username;
      // A new session: Discord does not replay what arrived while disconnected. Read it.
      void this.catchUp();
    }
    this.phase = "connected";
    this.message = undefined;
    this.settleReady();
  }

  /** After a fresh identify, read each known DM channel's messages since the last one handled. */
  private async catchUp(): Promise<void> {
    for (const [channelId, lastId] of Object.entries(this.state.conversations)) {
      if (this.retired) return;
      let messages: DiscordMessage[];
      try {
        messages = await this.rest.messagesAfter(channelId, lastId);
      } catch (error) {
        this.log("warn", "discord catch-up read failed", { status: httpStatus(error) });
        continue;
      }
      for (const message of messages) {
        this.counters.caughtUp += 1;
        this.enqueueInbound(message, "catch-up");
      }
    }
  }

  private hostFailed(error: unknown): void {
    if (isDeskmatesError(error) && FINAL_HOST_CODES.has(error.code)) return;
    this.log("warn", "discord host call failed", {
      error: isDeskmatesError(error) ? error.code : "internal",
    });
  }

  private scheduleSave(): void {
    if (this.retired || this.dirty || !this.state) return;
    this.dirty = true;
    this.saving = this.saving
      .then(async () => {
        this.dirty = false;
        if (this.retired) return;
        await saveDiscordState(this.options.request.stateDirectory, this.state);
      })
      .catch(() => this.log("warn", "discord state not saved"));
  }

  // ---------------------------------------------------------------- inbound

  private enqueueInbound(message: DiscordMessage, source: "gateway" | "catch-up"): void {
    this.inbound = this.inbound
      .then(() => this.handleInbound(message, source))
      .catch((error: unknown) => this.hostFailed(error));
  }

  private async handleInbound(message: DiscordMessage, source: string): Promise<void> {
    if (this.retired) return;
    const inbound = classifyDiscordMessage(message, this.state.botUserId ?? "");
    if (inbound.kind === "ignore") {
      this.counters.ignored += 1;
      return;
    }
    const command =
      inbound.images.length + inbound.imagesRefused + inbound.otherMedia === 0
        ? parseApprovalCommand(inbound.text)
        : undefined;
    if (command) await this.decide(inbound, command);
    else await this.post(inbound, source);
    this.markSeen(inbound.channelId, inbound.messageId);
  }

  private markSeen(channelId: string, messageId: string): void {
    if (!snowflakeAfter(messageId, this.state.conversations[channelId])) return;
    this.state.conversations[channelId] = messageId;
    this.scheduleSave();
  }

  private base(inbound: Extract<DiscordInbound, { kind: "direct" }>): ChannelInboundMessage {
    return {
      conversationKey: inbound.channelId,
      senderId: inbound.senderId,
      externalId: inbound.messageId,
      body: "",
    };
  }

  /** Whether the host admits this sender: an empty receive posts nothing and answers `empty`. */
  private async admitted(inbound: Extract<DiscordInbound, { kind: "direct" }>): Promise<boolean> {
    const result = await this.receive(this.base(inbound));
    if (result.status === "blocked") this.counters.blocked += 1;
    return result.status === "empty";
  }

  private async receive(input: ChannelInboundMessage): Promise<ChannelInboundResult> {
    const waits = this.options.timings.receiveRetryMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.host.receive(input);
      } catch (error) {
        const permanent = isDeskmatesError(error) && PERMANENT_HOST_CODES.has(error.code);
        const wait = waits[attempt];
        if (permanent || wait === undefined || this.retired) throw error;
        await new Promise((done) => setTimeout(done, wait));
      }
    }
  }

  private async post(
    inbound: Extract<DiscordInbound, { kind: "direct" }>,
    source: string,
  ): Promise<void> {
    if (inbound.images.length > 0 && !(await this.admitted(inbound))) return;
    const images: ChannelInboundImage[] = [];
    let refused = inbound.imagesRefused;
    for (const { attachment, mimeType } of inbound.images) {
      try {
        const bytes = await this.rest.download(attachment.url, CHANNEL_INBOUND_IMAGE_MAX_BYTES);
        images.push({ name: attachment.filename, mimeType, bytes });
      } catch (error) {
        refused += 1;
        this.log("warn", "discord image not downloaded", { status: httpStatus(error) });
      }
    }
    const result = await this.receive({
      ...this.base(inbound),
      body: inbound.text,
      title: `Discord ${inbound.senderName}`,
      ...(images.length > 0 ? { images } : {}),
    });
    switch (result.status) {
      case "blocked":
        this.counters.blocked += 1;
        return;
      case "duplicate":
        this.counters.duplicates += 1;
        return;
      case "posted":
        this.counters.received += 1;
        this.state.threads[result.thread.id] ??= { seq: 0 };
        this.scheduleSave();
        refused += result.imagesRefused;
        break;
      case "empty":
        refused += result.imagesRefused;
        break;
    }
    const notices: string[] = [];
    if (inbound.otherMedia > 0) notices.push(OTHER_MEDIA_NOTICE);
    if (refused > 0) notices.push(imagesRefusedNotice(refused));
    if (result.status === "empty" && notices.length === 0) notices.push(EMPTY_MESSAGE_NOTICE);
    if (notices.length > 0) {
      this.counters.refusedMedia += inbound.otherMedia + refused;
      await this.notify(inbound, notices.join("\n"));
    }
    if (source === "catch-up") this.log("info", "discord message read after reconnect");
  }

  private async decide(
    inbound: Extract<DiscordInbound, { kind: "direct" }>,
    command: ApprovalCommand,
  ): Promise<void> {
    const approval = await this.host.getApproval(command.approvalId);
    if (!approval) {
      if (await this.admitted(inbound)) await this.notify(inbound, APPROVAL_REFUSED_NOTICE);
      return;
    }
    try {
      await this.host.decideApproval({
        id: approval.id,
        decision: command.decision,
        senderId: inbound.senderId,
        ...(command.reason ? { reason: command.reason } : {}),
      });
      this.log("info", "decided an approval from Discord", { decision: command.decision });
    } catch (error) {
      if (!isDeskmatesError(error) || FINAL_HOST_CODES.has(error.code)) throw error;
      if (!(await this.admitted(inbound))) return;
      const notice =
        error.code === "invalid_transition"
          ? APPROVAL_SETTLED_NOTICE
          : error.code === "validation"
            ? APPROVAL_NOT_DECIDABLE_NOTICE
            : APPROVAL_REFUSED_NOTICE;
      await this.notify(inbound, notice);
    }
  }

  /** A plugin notice in reply to the person's message; not a thread message, so no send gate. */
  private async notify(
    inbound: Extract<DiscordInbound, { kind: "direct" }>,
    text: string,
  ): Promise<void> {
    if (this.retired) return;
    try {
      await this.rest.createMessage(inbound.channelId, text, inbound.messageId);
    } catch (error) {
      this.counters.sendFailures += 1;
      this.log("warn", "discord notice not delivered", { status: httpStatus(error) });
      if (error instanceof DiscordHttpError && error.status === 401)
        this.fail("revoked", "Discord refused the bot token.");
    }
  }

  // ---------------------------------------------------------------- outbound

  private relay(threadId: string): void {
    if (this.retired) return;
    this.outbound = this.outbound
      .then(() => this.relayThread(threadId))
      .catch((error: unknown) => this.hostFailed(error));
  }

  private scheduleRetry(threadId: string): void {
    if (this.retired || this.retryTimers.has(threadId)) return;
    const policy = this.options.timings.relayRetry;
    const delay = this.retryDelays.get(threadId) ?? policy.initialMs;
    this.retryDelays.set(threadId, Math.min(delay * 2, policy.maxMs));
    const timer = setTimeout(() => {
      this.retryTimers.delete(threadId);
      this.relay(threadId);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(threadId, timer);
  }

  private setCursor(threadId: string, cursor: DiscordThreadCursor): void {
    this.state.threads[threadId] = cursor;
    this.scheduleSave();
  }

  private async relayThread(threadId: string): Promise<void> {
    if (this.retired || this.phase === "revoked" || this.phase === "failed") return;
    const cursor = this.state.threads[threadId] ?? { seq: 0 };
    if (cursor.pending?.failed) return;
    let messages: Awaited<ReturnType<ChannelConnectionHost["listMessages"]>>;
    let channelId: string;
    try {
      messages = await this.host.listMessages(threadId, cursor.seq);
      channelId = await this.host.conversationKeyOf(threadId);
    } catch (error) {
      // An older generation's thread (after a rebind) is no longer this connection's.
      if (isDeskmatesError(error) && error.code === "not_found") {
        delete this.state.threads[threadId];
        this.scheduleSave();
        return;
      }
      throw error;
    }
    for (const message of messages) {
      if (this.retired) return;
      const permit = await this.host.beginSend({ threadId, seq: message.seq });
      if (!permit.send) {
        this.setCursor(threadId, { seq: message.seq });
        continue;
      }
      const chunks = chunkDiscordText(renderDiscordMessage(message));
      const current = this.state.threads[threadId] ?? { seq: cursor.seq };
      const ids = current.pending?.seq === message.seq ? [...current.pending.chunkIds] : [];
      let permanent = false;
      for (let index = ids.length; index < chunks.length; index += 1) {
        try {
          const sent = await this.rest.createMessage(channelId, chunks[index] ?? "");
          ids.push(sent.id);
          this.setCursor(threadId, {
            seq: current.seq,
            pending: { seq: message.seq, chunkIds: [...ids] },
          });
        } catch (error) {
          this.counters.sendFailures += 1;
          const status = httpStatus(error);
          if (error instanceof DiscordHttpError && error.status === 401) {
            this.fail("revoked", "Discord refused the bot token.");
            return;
          }
          if (!(error instanceof DiscordHttpError) || error.retryable) {
            this.log("warn", "discord send failed; will retry", { status });
            this.scheduleRetry(threadId);
            return;
          }
          // A permanent refusal (for example 50007, the person blocked DMs): drop it once.
          this.log(
            "warn",
            ids.length > 0
              ? "discord refused a partial send; remaining chunks retained"
              : "discord refused a send; message dropped",
            {
              status,
              code: error.code ?? null,
            },
          );
          if (ids.length > 0) {
            this.setCursor(threadId, {
              seq: current.seq,
              pending: { seq: message.seq, chunkIds: [...ids], failed: true },
            });
            return;
          }
          permanent = true;
          break;
        }
      }
      if (!permanent && ids.length > 0) {
        await this.host.recordSend({ threadId, seq: message.seq, providerMessageIds: ids });
        this.counters.sent += 1;
      }
      this.setCursor(threadId, { seq: message.seq });
    }
    this.retryDelays.delete(threadId);
  }
}

function httpStatus(error: unknown): number | null {
  return error instanceof DiscordHttpError ? error.status : null;
}
