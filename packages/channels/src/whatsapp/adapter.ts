// The WhatsApp adapter proper (ADR-0017): admits a sender, binds it to a thread, posts its text
// idempotently, answers approval commands, and relays everything else in the thread back to the
// phone. It holds no WhatsApp knowledge the Gateway needs and no Gateway knowledge Meta needs.

import {
  type ThreadMessage,
  WHATSAPP_CHANNEL,
  channelAuthorId,
  isApprovalAttachmentMime,
  isChannelAuthorId,
} from "@deskmates/contracts";
import { type ApprovalCommand, approvalInstruction, parseApprovalCommand } from "./commands.js";
import type { WhatsAppConfig } from "./config.js";
import {
  type ChannelGatewayClient,
  type GatewayFrame,
  GatewayRejected,
  GatewayUnavailable,
} from "./gateway-client.js";
import { type SendResult, chunkText, sendText } from "./outbound.js";
import type { BoundThread, StateStore } from "./state.js";
import { type InboundEvent, parseWebhookPayload } from "./webhook-payload.js";

export interface AdapterLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface WhatsAppAdapterOptions {
  config: Pick<WhatsAppConfig, "phoneNumberId" | "allowedSenders" | "workspaceId" | "botIds"> &
    Partial<WhatsAppConfig>;
  gateway: ChannelGatewayClient;
  state: StateStore;
  /** How the adapter reaches the Graph API; tests pass a fake. */
  fetch?: typeof fetch;
  /** Linked-device transport; Cloud API callers keep using fetch. */
  send?: (to: string, text: string) => Promise<SendResult>;
  log: AdapterLog;
  sleep?: (ms: number) => Promise<void>;
  /**
   * How long to wait before relaying a thread again after a transient send failure (decision 6):
   * doubles from `initialMs` up to `maxMs`, reset by a successful pass. Tests shorten it.
   */
  relayRetry?: { initialMs: number; maxMs: number };
}

/** Counts the operational metrics ADR-0017's verification table reports. */
export type AdapterCounter =
  | "inbound_text"
  | "inbound_duplicate"
  | "dropped_unlisted_sender"
  | "dropped_other_number"
  | "dropped_unsupported"
  | "dropped_malformed"
  | "dropped_delisted_recipient"
  | "statuses"
  | "approval_decided"
  | "approval_refused"
  | "relayed"
  | "send_failed"
  | "send_deferred";

export const UNSUPPORTED_NOTICE = "Only text messages reach the bots. Please send text.";
export const APPROVAL_REFUSED_NOTICE =
  "That approval is not part of this conversation, so it was not decided.";
export const APPROVAL_SETTLED_NOTICE = "That approval was already decided.";

const RELAY_RETRY_DEFAULT = { initialMs: 5_000, maxMs: 60_000 };

export class WhatsAppAdapter {
  readonly counters: Record<AdapterCounter, number> = {
    inbound_text: 0,
    inbound_duplicate: 0,
    dropped_unlisted_sender: 0,
    dropped_other_number: 0,
    dropped_unsupported: 0,
    dropped_malformed: 0,
    dropped_delisted_recipient: 0,
    statuses: 0,
    approval_decided: 0,
    approval_refused: 0,
    relayed: 0,
    send_failed: 0,
    send_deferred: 0,
  };
  private readonly relays = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryDelays = new Map<string, number>();
  private readonly memberNames = new Map<string, Map<string, string>>();
  private controller: AbortController | undefined;
  private subscription: Promise<void> | undefined;

  constructor(private readonly opts: WhatsAppAdapterOptions) {}

  /**
   * One webhook delivery. 200 means Meta must not retry: everything was posted, deduplicated or
   * deliberately dropped. 503 means the Gateway was unreachable part way; Meta retries the whole
   * body and `externalId` keeps the already-posted part from doubling (decision 5).
   */
  async handleWebhook(body: unknown): Promise<{ status: 200 | 503 }> {
    const events = parseWebhookPayload(body);
    try {
      for (const event of events) await this.handleEvent(event);
    } catch (err) {
      if (err instanceof GatewayUnavailable) {
        this.opts.log.warn("gateway unavailable while handling a webhook; asking Meta to retry", {
          error: err.message,
        });
        return { status: 503 };
      }
      throw err;
    }
    return { status: 200 };
  }

  /** A transport-reduced event, sharing admission, deduplication and approval semantics. */
  async handleInbound(event: InboundEvent): Promise<void> {
    await this.handleEvent(event);
  }

  private async handleEvent(event: InboundEvent): Promise<void> {
    switch (event.kind) {
      case "status":
        this.counters.statuses += event.count;
        return;
      case "malformed":
        this.counters.dropped_malformed += 1;
        this.opts.log.warn("dropped a malformed webhook item", { detail: event.detail });
        return;
      case "unsupported":
        if (!this.admitted(event.from, event.phoneNumberId, event.id)) return;
        this.counters.dropped_unsupported += 1;
        this.opts.log.info("dropped a non-text message", { type: event.type, id: event.id });
        await this.notify(event.from, UNSUPPORTED_NOTICE);
        return;
      case "text": {
        if (!this.admitted(event.from, event.phoneNumberId, event.id)) return;
        const command = parseApprovalCommand(event.text);
        if (command) {
          await this.decide(event.from, command);
          return;
        }
        const binding = await this.ensureBinding(event.from);
        const posted = await this.opts.gateway.postHumanMessage(
          binding.threadId,
          event.text,
          channelAuthorId(WHATSAPP_CHANNEL, event.from),
          event.id,
        );
        if (posted.duplicate) {
          this.counters.inbound_duplicate += 1;
        } else {
          this.counters.inbound_text += 1;
          this.opts.log.info("posted a WhatsApp message", {
            threadId: binding.threadId,
            messageId: posted.message.id,
            runs: posted.runs.length,
          });
        }
        return;
      }
    }
  }

  /** Decision 4: the configured number and the allowlist; everything else is acknowledged and dropped. */
  private admitted(from: string, phoneNumberId: string, id: string): boolean {
    if (phoneNumberId !== this.opts.config.phoneNumberId) {
      this.counters.dropped_other_number += 1;
      this.opts.log.warn("dropped a message for another phone number id", { id, phoneNumberId });
      return false;
    }
    if (!this.opts.config.allowedSenders.has(from)) {
      this.counters.dropped_unlisted_sender += 1;
      this.opts.log.warn("dropped a message from a sender not on the allowlist", { id });
      return false;
    }
    return true;
  }

  /** Decision 3: one thread per sender on this number, found or created through the Gateway. */
  private async ensureBinding(from: string): Promise<BoundThread> {
    const cached = this.opts.state.byRecipient(from);
    if (cached) return cached;
    const externalKey = `${this.opts.config.phoneNumberId}:${from}`;
    const existing = await this.opts.gateway.findThread(WHATSAPP_CHANNEL, externalKey);
    let threadId: string;
    let relayedSeq = 0;
    if (existing) {
      threadId = existing.id;
      // Known to the Gateway but not to this adapter instance: do not replay its history.
      const history = await this.opts.gateway.listMessages(threadId, 0);
      relayedSeq = history.reduce((max, m) => Math.max(max, m.seq), 0);
    } else {
      const created = await this.opts.gateway.createThread({
        workspaceId: this.opts.config.workspaceId,
        botIds: this.opts.config.botIds,
        channel: WHATSAPP_CHANNEL,
        externalKey,
        title: `WhatsApp ${from}`,
      });
      threadId = created.id;
    }
    const entry: BoundThread = { threadId, to: from, relayedSeq, sentChunks: 0 };
    this.opts.state.put(entry);
    return entry;
  }

  /** Decision 7: decide only approvals of the sender's own thread; never post the command. */
  private async decide(from: string, command: ApprovalCommand): Promise<void> {
    const binding = this.opts.state.byRecipient(from) ?? (await this.lookupBinding(from));
    const approval = await this.opts.gateway.getApproval(command.approvalId);
    if (!binding || !approval || approval.threadId !== binding.threadId) {
      this.counters.approval_refused += 1;
      this.opts.log.warn("refused an approval command outside the sender's thread", {
        approvalId: command.approvalId,
      });
      await this.notify(from, APPROVAL_REFUSED_NOTICE);
      return;
    }
    try {
      await this.opts.gateway.decideApproval(
        approval.id,
        command.decision,
        channelAuthorId(WHATSAPP_CHANNEL, from),
        command.reason,
      );
      this.counters.approval_decided += 1;
      this.opts.log.info("decided an approval from WhatsApp", {
        approvalId: approval.id,
        decision: command.decision,
      });
    } catch (err) {
      if (err instanceof GatewayRejected && err.status === 409) {
        await this.notify(from, APPROVAL_SETTLED_NOTICE);
        return;
      }
      throw err;
    }
  }

  private async lookupBinding(from: string): Promise<BoundThread | undefined> {
    const existing = await this.opts.gateway.findThread(
      WHATSAPP_CHANNEL,
      `${this.opts.config.phoneNumberId}:${from}`,
    );
    if (!existing) return undefined;
    const history = await this.opts.gateway.listMessages(existing.id, 0);
    const entry: BoundThread = {
      threadId: existing.id,
      to: from,
      relayedSeq: history.reduce((max, m) => Math.max(max, m.seq), 0),
      sentChunks: 0,
    };
    this.opts.state.put(entry);
    return entry;
  }

  /** Begin relaying: subscribe to the Gateway's SSE feed until `stop()`. */
  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    this.subscription = this.opts.gateway.subscribe(
      {
        onFrame: (frame) => this.onFrame(frame),
        onOpen: async () => {
          for (const entry of this.opts.state.all()) this.relay(entry.threadId);
        },
      },
      this.controller.signal,
    );
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await this.subscription?.catch(() => undefined);
    await Promise.allSettled([...this.relays.values()]);
  }

  private onFrame(frame: GatewayFrame): void {
    if (frame.type !== "thread_message" || !frame.threadId) return;
    if (!this.opts.state.get(frame.threadId)) return;
    this.relay(frame.threadId);
  }

  /** Decision 6: at least once, in seq order, one thread at a time. Returns when this pass ends. */
  relay(threadId: string): Promise<void> {
    const previous = this.relays.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.relayPass(threadId)).catch(() => undefined);
    this.relays.set(threadId, next);
    return next;
  }

  /**
   * One pass over the thread's unrelayed messages. The cursor moves only past a message that was
   * delivered in full (or deliberately dropped); a transient send failure keeps the cursor, keeps
   * the count of chunks already delivered, and schedules another pass.
   */
  private async relayPass(threadId: string): Promise<void> {
    const entry = this.opts.state.get(threadId);
    if (!entry) return;
    let messages: ThreadMessage[];
    try {
      messages = await this.opts.gateway.listMessages(threadId, entry.relayedSeq);
    } catch (err) {
      this.opts.log.warn("could not read the thread to relay it; will retry", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleRetry(threadId);
      return;
    }
    // Decision 4: a sender removed from the allowlist receives nothing further. The cursor still
    // moves, so re-adding the number does not replay what it was not allowed to see.
    const delisted = !this.opts.config.allowedSenders.has(entry.to);
    if (delisted && messages.some((m) => m.seq > entry.relayedSeq)) {
      this.opts.log.warn("recipient is no longer on the allowlist; not relaying", { threadId });
    }
    for (const message of messages) {
      if (message.seq <= entry.relayedSeq) continue;
      if (delisted) {
        if (!this.ownMessage(message)) this.counters.dropped_delisted_recipient += 1;
      } else if (!this.ownMessage(message)) {
        const chunks = chunkText(await this.render(threadId, message));
        const start = message.seq === entry.relayedSeq + 1 ? (entry.sentChunks ?? 0) : 0;
        let outcome: "delivered" | "dropped" | "deferred" = "delivered";
        for (let i = start; i < chunks.length; i++) {
          const result = await this.send(entry.to, chunks[i] as string);
          if (result.ok) {
            this.counters.relayed += 1;
            entry.sentChunks = i + 1;
            this.opts.state.put(entry);
            continue;
          }
          const facts = {
            threadId,
            messageId: message.id,
            status: result.status,
            code: result.code ?? null,
            attempts: result.attempts,
            chunk: i + 1,
            chunks: chunks.length,
          };
          if (result.retryable) {
            this.counters.send_deferred += 1;
            this.opts.log.warn(
              "WhatsApp is not accepting sends; keeping the message for retry",
              facts,
            );
            outcome = "deferred";
          } else {
            this.counters.send_failed += 1;
            this.opts.log.warn("WhatsApp refused a thread message; dropping it", facts);
            outcome = "dropped";
          }
          break;
        }
        if (outcome === "deferred") {
          this.scheduleRetry(threadId);
          return;
        }
      }
      entry.relayedSeq = message.seq;
      entry.sentChunks = 0;
      this.opts.state.put(entry);
    }
    this.retryDelays.delete(threadId);
  }

  private scheduleRetry(threadId: string): void {
    if (!this.controller || this.retryTimers.has(threadId)) return;
    const policy = this.opts.relayRetry ?? RELAY_RETRY_DEFAULT;
    const delay = this.retryDelays.get(threadId) ?? policy.initialMs;
    this.retryDelays.set(threadId, Math.min(delay * 2, policy.maxMs));
    const timer = setTimeout(() => {
      this.retryTimers.delete(threadId);
      this.relay(threadId);
    }, delay);
    timer.unref();
    this.retryTimers.set(threadId, timer);
  }

  /** The sender's own messages, as the Gateway stored them, are not echoed back. */
  private ownMessage(message: ThreadMessage): boolean {
    return message.authorKind === "human" && isChannelAuthorId(message.authorId, WHATSAPP_CHANNEL);
  }

  private async render(threadId: string, message: ThreadMessage): Promise<string> {
    let label = "";
    if (message.authorKind === "bot") {
      label = `${await this.memberName(threadId, message.authorId)}: `;
    } else if (message.authorKind === "human") {
      label = `${message.authorId || "operator"}: `;
    }
    const approval = message.attachments.find((a) => isApprovalAttachmentMime(a.mimeType));
    const instruction = approval ? `\n${approvalInstruction(approval.ref)}` : "";
    return `${label}${message.body}${instruction}`;
  }

  private async memberName(threadId: string, botId: string): Promise<string> {
    let names = this.memberNames.get(threadId);
    if (!names?.has(botId)) {
      try {
        const detail = await this.opts.gateway.getThread(threadId);
        names = new Map(detail.members.map((m) => [m.botId as string, m.name]));
        this.memberNames.set(threadId, names);
      } catch {
        // The id is still a usable label.
      }
    }
    return names?.get(botId) ?? botId;
  }

  private async notify(to: string, text: string): Promise<void> {
    const result = await this.send(to, text);
    if (!result.ok) {
      this.counters.send_failed += 1;
      this.opts.log.warn("could not deliver a notice to WhatsApp", {
        status: result.status,
        code: result.code ?? null,
      });
    }
  }

  private send(to: string, text: string): Promise<SendResult> {
    if (this.opts.send) return this.opts.send(to, text);
    const { config } = this.opts;
    if (
      !this.opts.fetch ||
      !config.graphBaseUrl ||
      !config.graphApiVersion ||
      !config.accessToken ||
      config.sendRetries === undefined
    ) {
      throw new Error("WhatsApp transport is not configured");
    }
    return sendText(
      {
        fetch: this.opts.fetch,
        graphBaseUrl: config.graphBaseUrl,
        graphApiVersion: config.graphApiVersion,
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        retries: config.sendRetries,
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      },
      to,
      text,
    );
  }
}
