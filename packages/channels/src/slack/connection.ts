// One live Slack connection: one Slack app installed in one Slack workspace, bound to one Bot
// through the connection-scoped host (ADR-0047). It keeps a Socket Mode WebSocket open with the
// app-level token, acknowledges every envelope, turns direct messages into `host.receive`, and
// relays the thread back with `chat.postMessage` and the bot token, through the send gate.
//
// Delivery is at least once in both directions. An envelope is acknowledged after its message is
// posted, or at the acknowledgement deadline when posting takes longer (Slack wants an answer in
// three seconds); a Gateway failure before that leaves it unacknowledged so Slack redelivers it,
// and the event id, remembered here and deduplicated again by the host, keeps a redelivery from
// posting twice. A crash after the deadline acknowledgement and before the post loses that one
// message; that is the documented failure, as is a duplicate visible reply after a send whose
// receipt was not recorded.

import {
  CHANNEL_INBOUND_IMAGES_MAX,
  CHANNEL_INBOUND_IMAGE_MAX_BYTES,
  CHANNEL_INBOUND_IMAGE_TYPES,
  type ChannelConnectionHost,
  type ChannelConnectionStatus,
  type ChannelInboundImage,
  type ChannelOpenRequest,
  DeskmatesError,
  type ThreadMessage,
  isApprovalAttachmentMime,
  isChannelAuthorId,
} from "@deskmates/contracts";
import { approvalInstruction, parseApprovalCommand } from "../whatsapp/commands.js";
import {
  type SlackDirectMessage,
  type SlackEnvelopePayload,
  type SlackEventOrigin,
  type SlackFileRef,
  parseSlackFrame,
} from "./events.js";
import type { SlackStateStore, SlackThreadCursor } from "./state.js";
import { chunkSlackText, escapeSlackText, slackTextToPlain } from "./text.js";
import { type SlackSocket, type SlackTransport, isSlackFileUrl } from "./transport.js";
import { SlackApiError, type SlackWebApi } from "./web-api.js";

export const SLACK_CHANNEL = "slack";

export const SLACK_NOTICES = {
  otherMedia: (count: number) =>
    `Only text and images reach the assistant here, so ${count === 1 ? "1 file was" : `${count} files were`} not received.`,
  imagesRefused: (count: number) =>
    `${count === 1 ? "1 image" : `${count} images`} could not be received.`,
  threadReply:
    "Replies in threads are not supported here. Please write in the main conversation instead.",
  approvalForeign: "That approval is not part of this conversation, so it was not decided.",
  approvalSettled: "That approval was already decided.",
} as const;

/** What the plugin knows about the connection's identity after checking the bot token. */
export interface SlackIdentityFacts {
  /** The team id, or the enterprise id of an org-wide install: the identity key's namespace. */
  namespace: string;
  enterpriseInstall: boolean;
  appId: string;
  /** The bot's own user id: its messages are not inbound, `tokens_revoked` names it. */
  botUserId: string;
  label: string;
}

export interface SlackCredentials {
  botToken: string;
  appToken: string;
}

export interface SlackTimings {
  /** Delay before reconnect attempt `attempt` (0-based) after an unexpected socket loss. */
  reconnectDelayMs: (attempt: number) => number;
  /** Acknowledge an envelope at this age even if posting has not finished. */
  ackDeadlineMs: number;
  /** Delay before relaying a thread again after a transient send failure. */
  relayRetryMs: (attempt: number) => number;
}

export const SLACK_TIMINGS_DEFAULT: SlackTimings = {
  reconnectDelayMs: (attempt) => Math.min(1000 * 2 ** attempt, 60_000),
  ackDeadlineMs: 2500,
  relayRetryMs: (attempt) => Math.min(2000 * 2 ** attempt, 120_000),
};

export interface SlackConnectionOptions {
  request: ChannelOpenRequest;
  host: ChannelConnectionHost;
  credentials: SlackCredentials;
  api: SlackWebApi;
  transport: SlackTransport;
  state: SlackStateStore;
  /** Checks the bot token and returns who it belongs to; the runtime's `verify` uses the same. */
  identify: (credentials: SlackCredentials) => Promise<SlackIdentityFacts>;
  timings: SlackTimings;
}

type Phase = "connecting" | "connected" | "reconnecting" | "revoked" | "error" | "stopped";

interface Counters {
  reconnects: number;
  ignoredEvents: number;
  duplicateEvents: number;
  foreignEvents: number;
  refusedFiles: number;
  sendFailures: number;
}

type SocketOutcome = "disconnect" | "closed" | "link_disabled" | "app_mismatch";

const isStale = (error: unknown): boolean =>
  error instanceof DeskmatesError && error.code === "channel_connection_stale";

const errorCode = (error: unknown): string =>
  error instanceof SlackApiError
    ? error.code
    : error instanceof DeskmatesError
      ? error.code
      : "error";

export class SlackConnection {
  private phase: Phase = "connecting";
  private message: string | undefined;
  private closed = false;
  private identity: SlackIdentityFacts | undefined;
  private socket: SlackSocket | undefined;
  private endSocket: ((outcome: SocketOutcome) => void) | undefined;
  private readonly subscription = new AbortController();
  private readonly wakeups = new Set<() => void>();
  private readonly inflight = new Set<string>();
  private inbound: Promise<void> = Promise.resolve();
  private readonly relays = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly counters: Counters = {
    reconnects: 0,
    ignoredEvents: 0,
    duplicateEvents: 0,
    foreignEvents: 0,
    refusedFiles: 0,
    sendFailures: 0,
  };
  /** Resolves when the socket loop has ended for good. */
  readonly done: Promise<void>;

  constructor(private readonly options: SlackConnectionOptions) {
    this.done = this.run();
  }

  get connectionId(): string {
    return this.options.request.connectionId;
  }

  status(): ChannelConnectionStatus {
    return {
      phase: this.phase,
      ...(this.message ? { message: this.message } : {}),
      ...(this.identity ? { account: this.identity.label } : {}),
      details: { ...this.counters },
    };
  }

  /** Stop the socket, the relays and every timer; never touch the host again. */
  async close(): Promise<void> {
    if (this.closed && !this.socket) return;
    if (this.phase !== "revoked" && this.phase !== "error") this.setPhase("stopped");
    this.halt();
    this.endSocket?.("closed");
    this.socket?.close();
    // The loop notices `closed` after its current await; do not hold a disconnect hostage to a
    // slow Slack call.
    await Promise.race([this.done, new Promise<void>((done) => setTimeout(done, 1000).unref?.())]);
  }

  /** Disconnect: forget cursors and event ids. */
  removeState(): void {
    this.options.state.remove();
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  private setPhase(phase: Phase, message?: string): void {
    this.phase = phase;
    this.message = message;
  }

  private log(level: "info" | "warn", message: string, data?: Record<string, unknown>): void {
    if (this.closed && level === "info") return;
    try {
      this.options.host.log(level, message, data);
    } catch {
      // A stale host may refuse even logging; nothing else to do.
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wakeups.delete(finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      this.wakeups.add(finish);
    });
  }

  /** The host refused a call as stale: this handle is over; the Gateway opens a new one. */
  private stale(): void {
    if (this.closed) return;
    this.log("warn", "Slack connection handle is stale; stopping it");
    void this.close();
  }

  /**
   * The socket loop. When it ends for good (revoked, refused, wrong identity) the relays stop too,
   * so a connection never sends with a token that is no longer the connection's identity.
   */
  private async run(): Promise<void> {
    try {
      await this.loop();
    } finally {
      this.halt();
    }
  }

  private halt(): void {
    this.closed = true;
    this.subscription.abort();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const wake of [...this.wakeups]) wake();
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      let outcome: SocketOutcome = "closed";
      let greeted = false;
      try {
        if (!this.identity) {
          const identity = await this.options.identify(this.options.credentials);
          if (
            `slack:${identity.namespace}:${identity.appId}` !== this.options.request.identityKey
          ) {
            this.setPhase(
              "error",
              "The bot token now belongs to a different Slack app or workspace.",
            );
            this.log("warn", "Slack bot token belongs to another identity; not connecting");
            return;
          }
          this.identity = identity;
          // Relays start only once the bot token is known to be this connection's identity.
          this.subscribe();
        }
        const opened = await this.options.api.call(
          "apps.connections.open",
          this.options.credentials.appToken,
        );
        const url = typeof opened.url === "string" ? opened.url : "";
        if (!url.startsWith("wss://") && !url.startsWith("ws://"))
          throw new SlackApiError("apps.connections.open", "no_socket_url", true);
        if (this.closed) return;
        ({ outcome, greeted } = await this.runSocket(url));
      } catch (error) {
        if (this.closed) return;
        if (error instanceof SlackApiError && error.revoked) {
          this.setPhase("revoked", `Slack refused the token (${error.code}).`);
          this.log("warn", "Slack token refused; connection revoked", { code: error.code });
          return;
        }
        if (error instanceof SlackApiError && !error.retryable) {
          this.setPhase("error", `Slack refused the connection (${error.code}).`);
          this.log("warn", "Slack refused the connection", { code: error.code });
          return;
        }
        this.log("warn", "Slack connection attempt failed; will retry", {
          code: errorCode(error),
        });
      }
      if (this.closed) return;
      if (outcome === "link_disabled") {
        this.setPhase("error", "Socket Mode was turned off for the Slack app.");
        this.log("warn", "Slack disabled Socket Mode for the app; not reconnecting");
        return;
      }
      if (outcome === "app_mismatch") {
        this.setPhase("error", "The app-level token belongs to a different Slack app.");
        this.log("warn", "Slack app-level token belongs to another app; not reconnecting");
        return;
      }
      this.counters.reconnects += 1;
      this.setPhase("reconnecting");
      if (greeted) attempt = 0;
      // Slack asked us to move (refresh, warning): reconnect at once. Otherwise back off.
      if (outcome !== "disconnect") {
        await this.wait(this.options.timings.reconnectDelayMs(attempt));
        attempt += 1;
      }
    }
  }

  private runSocket(url: string): Promise<{ outcome: SocketOutcome; greeted: boolean }> {
    return new Promise((resolve) => {
      let finished = false;
      let greeted = false;
      const finish = (outcome: SocketOutcome): void => {
        if (finished) return;
        finished = true;
        this.endSocket = undefined;
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
        resolve({ outcome, greeted });
      };
      this.endSocket = finish;
      const socket = this.options.transport.openSocket(url, {
        onOpen: () => {},
        onClose: () => finish("closed"),
        onMessage: (text) => {
          if (finished) return;
          const identity = this.identity;
          if (!identity) return;
          const frame = parseSlackFrame(text, identity.botUserId);
          if (frame.kind === "hello") {
            if (frame.appId !== undefined && frame.appId !== identity.appId) {
              finish("app_mismatch");
              return;
            }
            greeted = true;
            this.setPhase("connected");
            return;
          }
          if (frame.kind === "disconnect") {
            finish(frame.reason === "link_disabled" ? "link_disabled" : "disconnect");
            return;
          }
          if (frame.kind === "envelope") this.onEnvelope(socket, frame.envelopeId, frame.payload);
        },
      });
      this.socket = socket;
      if (this.closed) finish("closed");
    });
  }

  // ---- inbound -----------------------------------------------------------------------------

  private onEnvelope(socket: SlackSocket, envelopeId: string, payload: SlackEnvelopePayload): void {
    let acked = false;
    const ack = (): void => {
      if (acked) return;
      acked = true;
      socket.send(JSON.stringify({ envelope_id: envelopeId }));
    };
    if (payload.kind === "ignored") {
      this.counters.ignoredEvents += 1;
      ack();
      return;
    }
    if (!this.fromThisInstallation(payload.origin)) {
      this.counters.foreignEvents += 1;
      this.log("warn", "ignored a Slack event for another app or workspace");
      ack();
      return;
    }
    const eventId = payload.kind === "message" ? payload.message.eventId : payload.eventId;
    if (this.options.state.hasEvent(eventId)) {
      this.counters.duplicateEvents += 1;
      ack();
      return;
    }
    if (this.inflight.has(eventId)) {
      // A redelivery while the first copy is still being posted; the first one acknowledges.
      this.counters.duplicateEvents += 1;
      return;
    }
    if (payload.kind === "revoked") {
      ack();
      this.options.state.addEvent(eventId);
      this.setPhase("revoked", "The Slack app was uninstalled or its tokens were revoked.");
      this.log("warn", "Slack app uninstalled or tokens revoked; connection revoked");
      void this.close();
      return;
    }
    this.inflight.add(eventId);
    const deadline = setTimeout(ack, this.options.timings.ackDeadlineMs);
    const message = payload.message;
    this.inbound = this.inbound.then(async () => {
      try {
        await this.handleMessage(message);
        this.options.state.addEvent(eventId);
        ack();
      } catch (error) {
        if (isStale(error)) {
          ack();
          this.stale();
        } else if (error instanceof DeskmatesError && error.code === "validation") {
          // The host will never accept this one; do not make Slack retry it.
          this.options.state.addEvent(eventId);
          ack();
          this.log("warn", "Slack message refused by the Gateway", { code: error.code });
        } else {
          // Unacknowledged before the deadline: Slack redelivers it.
          this.log("warn", "could not post a Slack message; Slack will redeliver it", {
            code: errorCode(error),
          });
        }
      } finally {
        clearTimeout(deadline);
        this.inflight.delete(eventId);
      }
    });
  }

  private fromThisInstallation(origin: SlackEventOrigin): boolean {
    const identity = this.identity;
    if (!identity || origin.appId !== identity.appId) return false;
    return identity.enterpriseInstall
      ? origin.enterpriseId === identity.namespace
      : origin.teamId === identity.namespace;
  }

  /**
   * Whether the host admits this sender, without posting anything: an empty `receive` is answered
   * `empty` for an admitted sender and `blocked` for a blocked one. Used before every notice and
   * approval decision, so a blocked person never hears from the connection.
   */
  private async admitted(message: SlackDirectMessage): Promise<boolean> {
    const probe = await this.options.host.receive({
      conversationKey: message.channel,
      senderId: message.user,
      externalId: message.eventId,
      body: "",
    });
    return probe.status === "empty";
  }

  private async handleMessage(message: SlackDirectMessage): Promise<void> {
    if (message.threadReply) {
      if (await this.admitted(message))
        await this.notice(message.channel, SLACK_NOTICES.threadReply);
      return;
    }
    const body = slackTextToPlain(message.text);
    const command = message.files.length === 0 ? parseApprovalCommand(body) : undefined;
    if (command) {
      await this.handleApproval(message, command);
      return;
    }
    const { images, refusedImages, refusedOther } = await this.downloadImages(message.files);
    this.counters.refusedFiles += refusedImages + refusedOther;
    const result = await this.options.host.receive({
      conversationKey: message.channel,
      senderId: message.user,
      externalId: message.eventId,
      body,
      ...(images.length > 0 ? { images } : {}),
    });
    if (result.status === "blocked") return;
    if (result.status === "duplicate") {
      this.track(result.threadId);
      return;
    }
    const imagesRefused = refusedImages + result.imagesRefused;
    if (refusedOther > 0)
      await this.notice(message.channel, SLACK_NOTICES.otherMedia(refusedOther));
    if (imagesRefused > 0)
      await this.notice(message.channel, SLACK_NOTICES.imagesRefused(imagesRefused));
    if (result.status === "posted") {
      this.track(result.thread.id);
      this.relay(result.thread.id);
    }
  }

  private async handleApproval(
    message: SlackDirectMessage,
    command: NonNullable<ReturnType<typeof parseApprovalCommand>>,
  ): Promise<void> {
    if (!(await this.admitted(message))) return;
    const { host } = this.options;
    const thread = await host.findThread(message.channel);
    const approval = await host.getApproval(command.approvalId);
    if (!thread || !approval || approval.threadId !== thread.id) {
      await this.notice(message.channel, SLACK_NOTICES.approvalForeign);
      return;
    }
    if (approval.decision !== undefined) {
      await this.notice(message.channel, SLACK_NOTICES.approvalSettled);
      return;
    }
    try {
      await host.decideApproval({
        id: approval.id,
        decision: command.decision,
        senderId: message.user,
        ...(command.reason ? { reason: command.reason } : {}),
      });
      this.log("info", "decided an approval from Slack", {
        approvalId: approval.id,
        decision: command.decision,
      });
    } catch (error) {
      if (isStale(error)) throw error;
      const code = errorCode(error);
      this.log("warn", "Slack approval decision refused", { approvalId: approval.id, code });
      if (code === "not_found") await this.notice(message.channel, SLACK_NOTICES.approvalForeign);
      else if (code === "invalid_transition" || code === "conflict")
        await this.notice(message.channel, SLACK_NOTICES.approvalSettled);
    }
  }

  /** Images the host may store, downloaded with the bot token; every other file is refused. */
  private async downloadImages(files: readonly SlackFileRef[]): Promise<{
    images: ChannelInboundImage[];
    refusedImages: number;
    refusedOther: number;
  }> {
    const images: ChannelInboundImage[] = [];
    let refusedImages = 0;
    let refusedOther = 0;
    for (const file of files) {
      if (!CHANNEL_INBOUND_IMAGE_TYPES.includes(file.mimeType)) {
        refusedOther += 1;
        continue;
      }
      if (
        images.length >= CHANNEL_INBOUND_IMAGES_MAX ||
        file.size > CHANNEL_INBOUND_IMAGE_MAX_BYTES ||
        !file.url ||
        !isSlackFileUrl(file.url)
      ) {
        refusedImages += 1;
        continue;
      }
      try {
        const download = await this.options.transport.download(
          file.url,
          this.options.credentials.botToken,
          CHANNEL_INBOUND_IMAGE_MAX_BYTES,
        );
        // Slack answers a request it does not authorise with an HTML sign-in page, not an error.
        if (
          download.status !== 200 ||
          !download.bytes ||
          download.bytes.byteLength === 0 ||
          !download.contentType.startsWith("image/")
        ) {
          refusedImages += 1;
          this.log("warn", "could not download a Slack image", {
            status: download.status,
            contentType: download.contentType,
          });
          continue;
        }
        images.push({ name: file.name, mimeType: file.mimeType, bytes: download.bytes });
      } catch {
        refusedImages += 1;
        this.log("warn", "could not download a Slack image", { status: 0 });
      }
    }
    return { images, refusedImages, refusedOther };
  }

  /** A short plugin notice to the person; not part of the transcript, never through the gate. */
  private async notice(channel: string, text: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.options.api.call("chat.postMessage", this.options.credentials.botToken, {
        channel,
        text: escapeSlackText(text),
      });
    } catch (error) {
      this.counters.sendFailures += 1;
      this.log("warn", "could not deliver a notice to Slack", { code: errorCode(error) });
    }
  }

  // ---- outbound ----------------------------------------------------------------------------

  private subscribe(): void {
    void this.options.host
      .subscribe(
        {
          onOpen: () => {
            for (const threadId of this.options.state.threads()) this.relay(threadId);
          },
          onFrame: (frame) => {
            if (frame.type === "thread_message") {
              this.track(frame.threadId);
              this.relay(frame.threadId);
            }
          },
        },
        this.subscription.signal,
      )
      .catch((error: unknown) => {
        if (isStale(error)) this.stale();
        else this.log("warn", "Slack relay subscription ended", { code: errorCode(error) });
      });
  }

  /** Remember a thread of this connection so a restart relays what it has not yet sent. */
  private track(threadId: string): void {
    if (!this.options.state.cursor(threadId))
      this.options.state.putCursor(threadId, { relayedSeq: 0 });
  }

  /** One pass at a time per thread, in seq order. */
  relay(threadId: string): Promise<void> {
    const previous = this.relays.get(threadId) ?? Promise.resolve();
    const next = previous
      .then(() => this.relayPass(threadId))
      .catch((error: unknown) => {
        if (isStale(error)) this.stale();
        else this.log("warn", "Slack relay pass failed", { code: errorCode(error) });
      });
    this.relays.set(threadId, next);
    return next;
  }

  private scheduleRetry(threadId: string): void {
    if (this.closed || this.retryTimers.has(threadId)) return;
    const attempt = this.retryAttempts.get(threadId) ?? 0;
    this.retryAttempts.set(threadId, attempt + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(threadId);
      void this.relay(threadId);
    }, this.options.timings.relayRetryMs(attempt));
    timer.unref?.();
    this.retryTimers.set(threadId, timer);
  }

  private render(message: ThreadMessage): string {
    const approval = message.attachments.find((a) => isApprovalAttachmentMime(a.mimeType));
    const instruction = approval ? `\n${approvalInstruction(approval.ref)}` : "";
    return `${message.body}${instruction}`;
  }

  private async relayPass(threadId: string): Promise<void> {
    if (this.closed) return;
    const { host, state, api, credentials } = this.options;
    let cursor: SlackThreadCursor = state.cursor(threadId) ?? { relayedSeq: 0 };
    let messages: ThreadMessage[];
    let channel: string;
    try {
      messages = await host.listMessages(threadId, cursor.relayedSeq);
      channel = await host.conversationKeyOf(threadId);
    } catch (error) {
      if (error instanceof DeskmatesError && error.code === "not_found") {
        state.dropThread(threadId);
        return;
      }
      throw error;
    }
    for (const message of messages) {
      if (this.closed) return;
      if (message.seq <= cursor.relayedSeq) continue;
      // The person's own messages are never echoed; skip them without asking the gate.
      const own =
        message.authorKind === "human" && isChannelAuthorId(message.authorId, host.channel);
      const permit = own ? undefined : await host.beginSend({ threadId, seq: message.seq });
      if (permit?.send) {
        const chunks = chunkSlackText(escapeSlackText(this.render(message)));
        const sent =
          cursor.sentChunkIds && cursor.relayedSeq + 1 === message.seq
            ? [...cursor.sentChunkIds]
            : [];
        let dropped = false;
        for (let index = sent.length; index < chunks.length; index += 1) {
          if (this.closed) return;
          try {
            const answer = await api.call("chat.postMessage", credentials.botToken, {
              channel,
              text: chunks[index] ?? "",
              unfurl_links: "false",
              unfurl_media: "false",
            });
            sent.push(typeof answer.ts === "string" ? answer.ts : `chunk-${index + 1}`);
            if (index + 1 < chunks.length) {
              cursor = { relayedSeq: cursor.relayedSeq, sentChunkIds: [...sent] };
              state.putCursor(threadId, cursor);
            }
          } catch (error) {
            this.counters.sendFailures += 1;
            const code = errorCode(error);
            if (error instanceof SlackApiError && error.revoked) {
              this.setPhase("revoked", `Slack refused the token (${code}).`);
              this.log("warn", "Slack token refused while sending; connection revoked", { code });
              await this.close();
              return;
            }
            if (error instanceof SlackApiError && error.retryable) {
              this.log("warn", "Slack is not accepting sends; keeping the message for retry", {
                threadId,
                seq: message.seq,
                code,
              });
              cursor = { relayedSeq: cursor.relayedSeq, sentChunkIds: [...sent] };
              state.putCursor(threadId, cursor);
              this.scheduleRetry(threadId);
              return;
            }
            this.log("warn", "Slack refused a thread message; dropping it", {
              threadId,
              seq: message.seq,
              code,
            });
            dropped = true;
            break;
          }
        }
        if (!dropped)
          await host.recordSend({ threadId, seq: message.seq, providerMessageIds: sent });
      }
      cursor = { relayedSeq: message.seq };
      state.putCursor(threadId, cursor);
    }
    this.retryAttempts.delete(threadId);
  }
}
