// The WhatsApp side of one ABI-2 connection (ADR-0047 amendment 1): the same conversation,
// approval and relay semantics as ADR-0017 decisions 3 to 7, with every Gateway step through the
// connection-scoped host. The host, not this file, admits senders (every sender unless the
// connection's blocklist names them, ADR-0017 amendment 3), resolves the conversation's thread,
// deduplicates message ids and gates every send; this file keeps the per-thread relay cursor and the
// delivered-chunk count (decision 6) and asks `admits` before it sends a notice to a person.

import {
  type ChannelConnectionHost,
  type ThreadMessage,
  isApprovalAttachmentMime,
} from "@deskmates/contracts";
import {
  APPROVAL_REFUSED_NOTICE,
  APPROVAL_SETTLED_NOTICE,
  type AdapterCounter,
  type AdapterLog,
  UNSUPPORTED_NOTICE,
} from "./adapter.js";
import { type ApprovalCommand, approvalInstruction, parseApprovalCommand } from "./commands.js";
import { type SendResult, chunkText } from "./outbound.js";
import type { BoundThread, StateStore } from "./state.js";
import { type InboundEvent, parseWebhookPayload } from "./webhook-payload.js";

export interface WhatsAppConnectionRelayOptions {
  host: ChannelConnectionHost;
  /**
   * The number this connection speaks for, as events name it: the Cloud API phone number id, or
   * `web:<linked number>`. Conversation keys are `<number>:<wa_id>`, as ABI 1 keyed them.
   */
  number: string;
  state: StateStore;
  send(to: string, text: string): Promise<SendResult>;
  log: AdapterLog;
  /** Retry delay after a transient send failure; doubles up to `maxMs` (decision 6). */
  relayRetry?: { initialMs: number; maxMs: number };
}

const RELAY_RETRY_DEFAULT = { initialMs: 5_000, maxMs: 60_000 };

/**
 * A typed Gateway error by its code. Read by shape, not `instanceof`: the host's errors come from
 * the Gateway's copy of contracts, which need not be this bundle's module instance.
 */
function isCode(error: unknown, ...codes: string[]): boolean {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && codes.includes(code);
}

/** The connection's host went stale (rebind, reconnect, disconnect): stop, never retry. */
export function isStaleHost(error: unknown): boolean {
  return isCode(error, "channel_connection_stale");
}

export class WhatsAppConnectionRelay {
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

  constructor(private readonly opts: WhatsAppConnectionRelayOptions) {}

  /**
   * One Cloud API webhook delivery: 200 when everything was posted, deduplicated or dropped; 503
   * when the host went stale part way, so Meta redelivers to the connection's current host and
   * the host's message-id deduplication keeps the posted part from doubling (decision 5).
   */
  async handleWebhook(body: unknown): Promise<{ status: 200 | 503 }> {
    try {
      for (const event of parseWebhookPayload(body)) await this.handleInbound(event);
    } catch (error) {
      if (!isStaleHost(error)) throw error;
      this.opts.log.warn("channel connection changed while handling a webhook; asking to retry");
      return { status: 503 };
    }
    return { status: 200 };
  }

  async handleInbound(event: InboundEvent): Promise<void> {
    switch (event.kind) {
      case "status":
        this.counters.statuses += event.count;
        return;
      case "malformed":
        this.counters.dropped_malformed += 1;
        this.opts.log.warn("dropped a malformed webhook item", { detail: event.detail });
        return;
      case "unsupported":
        if (!this.forThisNumber(event.phoneNumberId, event.id)) return;
        if (!(await this.admits(event.from, event.id))) return;
        this.counters.dropped_unsupported += 1;
        this.opts.log.info("dropped a non-text message", { type: event.type, id: event.id });
        await this.notify(event.from, UNSUPPORTED_NOTICE);
        return;
      case "text": {
        if (!this.forThisNumber(event.phoneNumberId, event.id)) return;
        const command = parseApprovalCommand(event.text);
        if (command) {
          if (await this.admits(event.from, event.id)) await this.decide(event.from, command);
          return;
        }
        const result = await this.opts.host.receive({
          conversationKey: this.conversationKey(event.from),
          senderId: event.from,
          externalId: event.id,
          body: event.text,
          title: `WhatsApp ${event.from}`,
        });
        if (result.status === "blocked") {
          this.counters.dropped_unlisted_sender += 1;
          this.opts.log.warn("dropped a message from a blocked sender", { id: event.id });
          return;
        }
        if (result.status === "duplicate") {
          this.counters.inbound_duplicate += 1;
          return;
        }
        if (result.status === "empty") return;
        this.counters.inbound_text += 1;
        this.opts.log.info("posted a WhatsApp message", {
          threadId: result.thread.id,
          messageId: result.message.id,
          runs: result.runs.length,
        });
        await this.track(result.thread.id, event.from, result.message.seq);
        return;
      }
    }
  }

  /** Decision 4: events for another number are acknowledged and dropped. */
  private forThisNumber(number: string, id: string): boolean {
    if (number === this.opts.number) return true;
    this.counters.dropped_other_number += 1;
    this.opts.log.warn("dropped a message for another phone number id", {
      id,
      phoneNumberId: number,
    });
    return false;
  }

  /** Admission through the host: a sender it does not admit gets nothing, not even a notice. */
  private async admits(from: string, id: string): Promise<boolean> {
    const admitted = this.opts.host.admits ? await this.opts.host.admits(from) : false;
    if (!admitted) {
      this.counters.dropped_unlisted_sender += 1;
      this.opts.log.warn("dropped a message from a blocked sender", { id });
    }
    return admitted;
  }

  private conversationKey(from: string): string {
    return `${this.opts.number}:${from}`;
  }

  /**
   * Start relaying a thread the person just wrote in. A thread new to this state starts after
   * its earlier history, so a known conversation is never replayed; a thread whose only earlier
   * messages are system notices (the rebind notice of ADR-0047 decision 8) starts at the top so
   * the notice reaches the person before the reply.
   */
  private async track(threadId: string, to: string, postedSeq: number): Promise<void> {
    if (!this.opts.state.get(threadId)) {
      const earlier = (await this.opts.host.listMessages(threadId, 0)).filter(
        (message) => message.seq < postedSeq,
      );
      const known = earlier.some((message) => message.authorKind !== "system");
      this.opts.state.put({ threadId, to, relayedSeq: known ? postedSeq - 1 : 0, sentChunks: 0 });
    }
    void this.relay(threadId);
  }

  /** Decision 7: decide only approvals of the sender's own thread; never post the command. */
  private async decide(from: string, command: ApprovalCommand): Promise<void> {
    const thread = await this.opts.host.findThread(this.conversationKey(from));
    const approval = await this.opts.host.getApproval(command.approvalId);
    if (!thread || !approval || approval.threadId !== thread.id) {
      await this.refuseApproval(from, command.approvalId);
      return;
    }
    try {
      await this.opts.host.decideApproval({
        id: approval.id,
        decision: command.decision,
        senderId: from,
        ...(command.reason ? { reason: command.reason } : {}),
      });
      this.counters.approval_decided += 1;
      this.opts.log.info("decided an approval from WhatsApp", {
        approvalId: approval.id,
        decision: command.decision,
      });
    } catch (error) {
      if (isCode(error, "invalid_transition")) {
        await this.notify(from, APPROVAL_SETTLED_NOTICE);
        return;
      }
      if (isCode(error, "not_found", "forbidden", "validation")) {
        await this.refuseApproval(from, command.approvalId);
        return;
      }
      throw error;
    }
  }

  private async refuseApproval(from: string, approvalId: string): Promise<void> {
    this.counters.approval_refused += 1;
    this.opts.log.warn("refused an approval command outside the sender's thread", { approvalId });
    await this.notify(from, APPROVAL_REFUSED_NOTICE);
  }

  /** Subscribe to this connection's threads until `stop()`; every (re)open relays them all. */
  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    this.subscription = this.opts.host
      .subscribe(
        {
          onFrame: (frame) => {
            if (frame.type !== "thread_message" || !this.opts.state.get(frame.threadId)) return;
            void this.relay(frame.threadId);
          },
          onOpen: async () => {
            for (const entry of this.opts.state.all()) void this.relay(entry.threadId);
          },
        },
        this.controller.signal,
      )
      .catch((error: unknown) => {
        if (!isStaleHost(error)) throw error;
      });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await this.subscription?.catch(() => undefined);
    await Promise.allSettled([...this.relays.values()]);
  }

  /** Decision 6: at least once, in seq order, one thread at a time. Returns when this pass ends. */
  relay(threadId: string): Promise<void> {
    const previous = this.relays.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.relayPass(threadId)).catch(() => undefined);
    this.relays.set(threadId, next);
    return next;
  }

  /**
   * One pass over the thread's unrelayed messages. Each message passes the host's send gate
   * first: a refusal (the person's own message, already sent, cancelled at a fence, or a blocked
   * person) moves the cursor past it for good. A delivered message is
   * recorded with the provider's ids. A transient failure keeps the cursor and the delivered-chunk
   * count and schedules another pass.
   */
  private async relayPass(threadId: string): Promise<void> {
    const entry = this.opts.state.get(threadId);
    if (!entry || !this.controller) return;
    try {
      const messages = await this.opts.host.listMessages(threadId, entry.relayedSeq);
      for (const message of messages) {
        if (message.seq <= entry.relayedSeq) continue;
        const outcome = await this.relayOne(threadId, entry, message);
        if (outcome === "deferred") {
          this.scheduleRetry(threadId);
          return;
        }
        entry.relayedSeq = message.seq;
        entry.sentChunks = 0;
        this.opts.state.put(entry);
      }
      this.retryDelays.delete(threadId);
    } catch (error) {
      if (isStaleHost(error)) return;
      if (isCode(error, "not_found")) {
        // A thread of an older binding generation is no longer this connection's to serve.
        this.opts.state.remove(threadId);
        return;
      }
      this.opts.log.warn("could not relay the thread; will retry", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRetry(threadId);
    }
  }

  private async relayOne(
    threadId: string,
    entry: BoundThread,
    message: ThreadMessage,
  ): Promise<"done" | "deferred"> {
    const permit = await this.opts.host.beginSend({ threadId, seq: message.seq });
    if (!permit.send) {
      if (permit.reason === "blocked") {
        this.counters.dropped_delisted_recipient += 1;
        this.opts.log.warn("recipient is blocked; not relaying", { threadId });
      }
      return "done";
    }
    const chunks = chunkText(await this.render(threadId, message));
    const start = message.seq === entry.relayedSeq + 1 ? (entry.sentChunks ?? 0) : 0;
    const ids: string[] = [];
    for (let i = start; i < chunks.length; i++) {
      const result = await this.opts.send(entry.to, chunks[i] as string);
      if (result.ok) {
        this.counters.relayed += 1;
        if (result.messageId) ids.push(result.messageId);
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
        this.opts.log.warn("WhatsApp is not accepting sends; keeping the message for retry", facts);
        return "deferred";
      }
      this.counters.send_failed += 1;
      this.opts.log.warn("WhatsApp refused a thread message; dropping it", facts);
      return "done";
    }
    await this.opts.host.recordSend({ threadId, seq: message.seq, providerMessageIds: ids });
    return "done";
  }

  private scheduleRetry(threadId: string): void {
    if (!this.controller || this.retryTimers.has(threadId)) return;
    const policy = this.opts.relayRetry ?? RELAY_RETRY_DEFAULT;
    const delay = this.retryDelays.get(threadId) ?? policy.initialMs;
    this.retryDelays.set(threadId, Math.min(delay * 2, policy.maxMs));
    const timer = setTimeout(() => {
      this.retryTimers.delete(threadId);
      void this.relay(threadId);
    }, delay);
    timer.unref();
    this.retryTimers.set(threadId, timer);
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
        const detail = await this.opts.host.getThread(threadId);
        names = new Map(detail.members.map((m) => [m.botId as string, m.name]));
        this.memberNames.set(threadId, names);
      } catch {
        // The id is still a usable label.
      }
    }
    return names?.get(botId) ?? botId;
  }

  private async notify(to: string, text: string): Promise<void> {
    const result = await this.opts.send(to, text);
    if (!result.ok) {
      this.counters.send_failed += 1;
      this.opts.log.warn("could not deliver a notice to WhatsApp", {
        status: result.status,
        code: result.code ?? null,
      });
    }
  }
}
