// One live Telegram connection: one bot, one `ChannelConnectionHost`, one long-poll loop
// (`getUpdates`, so no public URL is needed) and one relay per thread (ADR-0047).
//
// Inbound: a private-chat message becomes one `host.receive` call with its text and images; the
// host applies the blocklist, deduplicates, creates the one-member thread and wakes the bound
// Bot. Groups, channels and topics are ignored. Other media is refused with a notice. The update
// offset advances only after an update was handled, so a crash redelivers it and the Gateway's
// deduplication keeps it from posting twice.
//
// Before any notice or approval decision that is not a posted message, the connection asks the
// host with an empty `receive` (no text, no image). That call posts nothing; it answers `blocked`
// for a blocked sender, so nothing is ever sent to one (ADR-0047 decision 13).
//
// Outbound: every message in this connection's threads not written by the person is relayed as
// plain text, chunked, through the send gate: `beginSend` before, `recordSend` with Telegram's
// message ids after. A transient failure (network, 429, 5xx) keeps the message and retries; a
// permanent refusal (another 4xx, for example a person who blocked the bot) drops it with a warn
// log; a revoked token stops the connection without dropping anything.

import type {
  ChannelConnectionHost,
  ChannelConnectionStatus,
  ChannelInboundImage,
  ChannelMenuRequest,
  ChannelOpenRequest,
} from "@deskmates/contracts";
import { CHANNEL_INBOUND_IMAGES_MAX, CHANNEL_INBOUND_IMAGE_MAX_BYTES } from "@deskmates/contracts";
import { type ApprovalCommand, parseApprovalCommand } from "../whatsapp/commands.js";
import { TelegramApiError, type TelegramBotApi, type TelegramUpdate } from "./bot-api.js";
import { telegramCommandMenu } from "./menu.js";
import { chunkTelegramText, renderForTelegram } from "./outbound.js";
import type { TelegramState } from "./state.js";
import {
  type ClassifiedUpdate,
  type TelegramImageRef,
  classifyUpdate,
  isTelegramCommand,
  sniffImageType,
} from "./updates.js";

export const CONTINUITY_HELP =
  "This is your ongoing conversation with the Agent. Send updates, questions or changes here; replies, results and important blockers stay in this conversation. /status shows current activity and delivery state. /help shows this help; /settings opens authorized Web settings. To decide a request, reply approve <id> or deny <id> [reason]. Agent and model settings are managed in Deskmates. This channel has no new, reset or stop command.";

export const OTHER_MEDIA_NOTICE =
  "Only text and images reach the assistant here. Voice messages, video, files, stickers and locations are not received.";
export const APPROVAL_REFUSED_NOTICE =
  "That approval is not part of this conversation, so it was not decided.";
export const APPROVAL_SETTLED_NOTICE = "That approval was already decided.";
export const REVOKED_MESSAGE =
  "Telegram refused the bot token. Relink the connection with a new token, or disconnect it.";
export const CONFLICT_MESSAGE =
  "Telegram reports another reader of this bot's updates (a webhook or another program). Remove it; retrying.";

export function imagesRefusedNotice(count: number): string {
  const what = count === 1 ? "One image was" : `${count} images were`;
  return `${what} not received. Images must be JPEG, PNG, GIF or WebP, at most 10 MB each and ${CHANNEL_INBOUND_IMAGES_MAX} per message.`;
}

/** Log a persistent Gateway delivery problem after this many tries; never skip the update. */
export const UPDATE_ATTEMPTS_MAX = 5;

export type TelegramCounter =
  | "received"
  | "duplicate"
  | "blocked"
  | "ignored_group"
  | "ignored_topic"
  | "ignored_other"
  | "media_refused"
  | "images_refused"
  | "approval_decided"
  | "approval_refused"
  | "relayed_chunks"
  | "send_deferred"
  | "send_failed"
  | "updates_dropped";

export interface TelegramConnectionOptions {
  request: ChannelOpenRequest;
  host: ChannelConnectionHost;
  api: TelegramBotApi;
  state: TelegramState;
  pollTimeoutSeconds: number;
  retry: { initialMs: number; maxMs: number };
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Handled = "done" | "retry" | "stale";

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

const isStale = (error: unknown): boolean => errorCode(error) === "channel_connection_stale";

/** The bot's numeric user id, the last segment of `telegram:bot:<id>`. */
export function botUserIdOf(identityKey: string): string {
  return identityKey.slice(identityKey.lastIndexOf(":") + 1);
}

export class TelegramConnection {
  readonly counters: Record<TelegramCounter, number> = {
    received: 0,
    duplicate: 0,
    blocked: 0,
    ignored_group: 0,
    ignored_topic: 0,
    ignored_other: 0,
    media_refused: 0,
    images_refused: 0,
    approval_decided: 0,
    approval_refused: 0,
    relayed_chunks: 0,
    send_deferred: 0,
    send_failed: 0,
    updates_dropped: 0,
  };
  private phase = "connecting";
  private message: string | undefined;
  private username: string | undefined;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private subscription: Promise<void> | undefined;
  private readonly relays = new Map<string, Promise<void>>();
  private readonly relayAgain = new Set<string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryDelays = new Map<string, number>();
  private readonly chats = new Map<string, string>();
  private readonly failures = new Map<number, number>();

  constructor(private readonly opts: TelegramConnectionOptions) {}

  private get signal(): AbortSignal {
    return this.abort.signal;
  }

  private log(level: "info" | "warn", message: string, data?: Record<string, unknown>): void {
    try {
      this.opts.host.log(level, message, data);
    } catch {
      // A stale host may refuse to log; nothing to do.
    }
  }

  status(): ChannelConnectionStatus {
    return {
      phase: this.phase,
      ...(this.message ? { message: this.message } : {}),
      ...(this.username ? { account: `@${this.username}` } : {}),
      details: {
        received: this.counters.received,
        blocked: this.counters.blocked,
        ignoredGroups: this.counters.ignored_group,
        mediaRefused: this.counters.media_refused,
        sendFailed: this.counters.send_failed,
      },
    };
  }

  private setPhase(phase: string, message?: string): void {
    this.phase = phase;
    this.message = message;
  }

  /** Check the token still names this bot, then start polling and relaying. */
  async start(): Promise<ChannelConnectionStatus> {
    const expected = botUserIdOf(this.opts.request.identityKey);
    try {
      const me = await this.opts.api.getMe(this.signal);
      if (String(me.id) !== expected) {
        this.setPhase(
          "identity_mismatch",
          "The stored token belongs to a different bot. Relink with this bot's token or disconnect.",
        );
        this.log("warn", "telegram token names another bot; not polling");
        return this.status();
      }
      this.username = typeof me.username === "string" ? me.username : undefined;
      this.setPhase("connected");
    } catch (error) {
      if (error instanceof TelegramApiError && error.revoked) {
        this.setPhase("revoked", REVOKED_MESSAGE);
        this.log("warn", "telegram refused the bot token; not polling", { status: error.status });
        return this.status();
      }
      // Telegram unreachable: the poll loop keeps retrying.
      this.setPhase("reconnecting", "Telegram is not reachable; retrying.");
    }
    this.subscription = this.opts.host
      .subscribe(
        {
          onOpen: async () => {
            const known = (await this.opts.host.listThreads?.()) ?? this.opts.state.threadIds();
            for (const threadId of known) void this.relay(threadId);
          },
          onFrame: (frame) => {
            if (frame.type === "thread_message" || frame.type === "run_status")
              void this.relay(frame.threadId);
          },
        },
        this.signal,
      )
      .catch((error: unknown) => {
        if (!isStale(error)) this.log("warn", "telegram relay subscription ended", {});
      });
    this.loop = this.poll();
    return this.status();
  }

  async commandMenu(input: ChannelMenuRequest) {
    // Lifecycle close aborts pending menu operations as well. Never affects poll/relay state.
    return telegramCommandMenu(
      this.opts.api,
      input,
      AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
    );
  }

  async close(): Promise<void> {
    this.abort.abort();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.allSettled([this.loop, this.subscription, ...this.relays.values()]);
    if (this.phase !== "revoked" && this.phase !== "identity_mismatch") this.setPhase("stopped");
  }

  // Inbound ---------------------------------------------------------------------------------

  private async poll(): Promise<void> {
    const { retry, sleep } = this.opts;
    let delay = retry.initialMs;
    while (!this.signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.opts.api.getUpdates(
          { offset: this.opts.state.offset, timeoutSeconds: this.opts.pollTimeoutSeconds },
          this.signal,
        );
      } catch (error) {
        if (this.signal.aborted) return;
        let wait = delay;
        if (error instanceof TelegramApiError) {
          if (error.revoked) {
            this.setPhase("revoked", REVOKED_MESSAGE);
            this.log("warn", "telegram refused the bot token; polling stopped", {
              status: error.status,
            });
            return;
          }
          if (error.conflict) this.setPhase("conflict", CONFLICT_MESSAGE);
          else this.setPhase("reconnecting", "Telegram is not reachable; retrying.");
          if (error.retryAfterSeconds !== undefined) wait = error.retryAfterSeconds * 1000;
          this.log("warn", "telegram getUpdates failed; retrying", { status: error.status });
        } else {
          this.setPhase("reconnecting", "Telegram is not reachable; retrying.");
        }
        await sleep(wait, this.signal);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }
      delay = retry.initialMs;
      if (this.phase !== "connected") this.setPhase("connected");
      let again = false;
      for (const update of updates) {
        if (this.signal.aborted) return;
        if (typeof update?.update_id !== "number") continue;
        const handled = await this.handleUpdate(update);
        if (handled === "stale") return;
        if (handled === "retry") {
          const attempts = (this.failures.get(update.update_id) ?? 0) + 1;
          this.failures.set(update.update_id, attempts);
          if (attempts === UPDATE_ATTEMPTS_MAX) {
            this.log("warn", "telegram update still waiting for the Gateway; retaining it", {
              attempts,
            });
          }
          this.setPhase(
            "reconnecting",
            "A received message is waiting for the Gateway; retrying without dropping it.",
          );
          again = true;
          delay = Math.min(retry.initialMs * 2 ** Math.min(attempts - 1, 20), retry.maxMs);
          break;
        }
        this.failures.delete(update.update_id);
        this.opts.state.offset = update.update_id + 1;
      }
      if (again) {
        await sleep(delay, this.signal);
        delay = Math.min(delay * 2, retry.maxMs);
      }
    }
  }

  /** Handle one update; `retry` keeps the offset so Telegram redelivers it. */
  async handleUpdate(update: TelegramUpdate): Promise<Handled> {
    const classified = classifyUpdate(update);
    if (classified.kind === "ignored") {
      if (classified.reason === "not_private") this.counters.ignored_group += 1;
      else if (classified.reason === "topic") this.counters.ignored_topic += 1;
      else this.counters.ignored_other += 1;
      return "done";
    }
    try {
      const command =
        classified.images.length === 0 && !classified.otherMedia
          ? parseApprovalCommand(classified.text)
          : undefined;
      if (command) return await this.decide(classified, command);
      if (classified.images.length === 0 && !classified.otherMedia && isTelegramCommand(update))
        return await this.information(classified);
      return await this.receive(classified);
    } catch (error) {
      if (isStale(error)) return "stale";
      if (this.signal.aborted) return "stale";
      this.log("warn", "telegram message not handed to the Gateway; will retry", {
        reason: errorCode(error) ?? "internal",
      });
      return "retry";
    }
  }

  private async receive(message: Extract<ClassifiedUpdate, { kind: "message" }>): Promise<Handled> {
    const { images, refused: refusedHere } = await this.download(message.images);
    const result = await this.opts.host.receive({
      conversationKey: message.conversationKey,
      senderId: message.senderId,
      externalId: message.externalId,
      body: message.text,
      title: `Telegram ${message.senderId}`,
      ...(images.length > 0 ? { images } : {}),
    });
    if (result.status === "blocked") {
      this.counters.blocked += 1;
      return "done";
    }
    if (result.status === "duplicate") {
      this.counters.duplicate += 1;
      // A crash may have committed inbound before saving the local relay cursor. Resolve the
      // current binding, never revive the old thread named by a cross-generation duplicate.
      const thread = await this.opts.host.findThread(message.conversationKey);
      if (thread) {
        this.opts.state.cursor(thread.id);
        this.chats.set(thread.id, message.conversationKey);
        void this.relay(thread.id);
      }
      return "done";
    }
    const refused = refusedHere + result.imagesRefused;
    if (result.status === "posted") {
      this.counters.received += 1;
      this.opts.state.cursor(result.thread.id);
      this.chats.set(result.thread.id, message.conversationKey);
      void this.relay(result.thread.id);
    }
    if (refused > 0) {
      this.counters.images_refused += refused;
      await this.notify(message.conversationKey, imagesRefusedNotice(refused));
    }
    if (message.otherMedia) {
      this.counters.media_refused += 1;
      await this.notify(message.conversationKey, OTHER_MEDIA_NOTICE);
    }
    return "done";
  }

  private async information(
    message: Extract<ClassifiedUpdate, { kind: "message" }>,
  ): Promise<Handled> {
    const probe = await this.opts.host.receive({
      conversationKey: message.conversationKey,
      senderId: message.senderId,
      externalId: message.externalId,
      body: "",
    });
    if (probe.status === "blocked") {
      this.counters.blocked += 1;
      return "done";
    }
    const parsed = /^\/(\w+)(?:@([\w]+))?(?:\s|$)/.exec(message.text.trim());
    if (parsed?.[2] && parsed[2].toLowerCase() !== this.username?.toLowerCase()) return "done";
    const command = parsed?.[1]?.toLowerCase();
    if (command === "settings") {
      const url = this.opts.request.config.webUrl;
      let link = "Open Deskmates in your browser to manage Agent and model settings.";
      if (typeof url === "string") {
        try {
          const parsed = new URL(url);
          if (parsed.protocol === "https:" && !parsed.username && !parsed.password)
            link = `Web settings: ${parsed.href}`;
        } catch {
          /* No configured link. */
        }
      }
      await this.notify(
        message.conversationKey,
        `${link} Sign in with your workspace account; Telegram access does not grant settings permissions.`,
      );
      return "done";
    }
    if (command !== "status") {
      await this.notify(
        message.conversationKey,
        command === "help" || command === "start"
          ? CONTINUITY_HELP
          : `Unknown command. ${CONTINUITY_HELP}`,
      );
      return "done";
    }
    const thread = await this.opts.host.findThread(message.conversationKey);
    if (!thread) {
      await this.notify(
        message.conversationKey,
        "No work has been started in this conversation. Send a message to the Agent to begin.",
      );
      return "done";
    }
    const activity = await this.opts.host.syncActivity?.(thread.id);
    await this.relay(thread.id);
    const cursor = this.opts.state.cursor(thread.id);
    const lines = [
      activity
        ? `Latest work: ${activity.status.replaceAll("_", " ")}.`
        : "No current work is recorded.",
      this.retryTimers.has(thread.id)
        ? "Message synchronization is waiting to retry."
        : `Message synchronization: ${this.phase}.`,
    ];
    if (cursor.failedDelivery)
      lines.push(
        `A message could not be delivered (message ${cursor.failedDelivery.seq}, Telegram ${cursor.failedDelivery.status}). Review it in Deskmates.`,
      );
    if (cursor.uncertainDeliverySeq)
      lines.push(
        `A previous send had no confirmed response (message ${cursor.uncertainDeliverySeq}); a retry may have duplicated it.`,
      );
    await this.notify(message.conversationKey, lines.join("\n"));
    return "done";
  }

  /** Download what may be stored; count the rest as refused. Never more than the host takes. */
  private async download(
    refs: readonly TelegramImageRef[],
  ): Promise<{ images: ChannelInboundImage[]; refused: number }> {
    const images: ChannelInboundImage[] = [];
    let refused = 0;
    for (const [index, ref] of refs.entries()) {
      if (index >= CHANNEL_INBOUND_IMAGES_MAX) {
        refused += 1;
        continue;
      }
      if (ref.fileSize !== undefined && ref.fileSize > CHANNEL_INBOUND_IMAGE_MAX_BYTES) {
        refused += 1;
        continue;
      }
      try {
        const file = await this.opts.api.getFile(ref.fileId, this.signal);
        if (!file.file_path) throw new TelegramApiError("getFile", 404, "no file path", undefined);
        if (file.file_size !== undefined && file.file_size > CHANNEL_INBOUND_IMAGE_MAX_BYTES)
          throw new TelegramApiError("getFile", 413, "file too large", undefined);
        const bytes = await this.opts.api.download(
          file.file_path,
          CHANNEL_INBOUND_IMAGE_MAX_BYTES,
          this.signal,
        );
        const mimeType = sniffImageType(bytes);
        if (!mimeType) throw new TelegramApiError("download", 415, "not an image", undefined);
        images.push({ name: ref.name, mimeType, bytes });
      } catch (error) {
        if (this.signal.aborted) throw error;
        refused += 1;
        this.log("warn", "telegram image not downloaded", {
          status: error instanceof TelegramApiError ? error.status : 0,
        });
      }
    }
    return { images, refused };
  }

  /** ADR-0017 decision 7's grammar: decide, never post. Nothing is sent to a blocked sender. */
  private async decide(
    message: Extract<ClassifiedUpdate, { kind: "message" }>,
    command: ApprovalCommand,
  ): Promise<Handled> {
    const probe = await this.opts.host.receive({
      conversationKey: message.conversationKey,
      senderId: message.senderId,
      externalId: message.externalId,
      body: "",
    });
    if (probe.status === "blocked") {
      this.counters.blocked += 1;
      return "done";
    }
    if (probe.status === "duplicate") return "done";
    try {
      const approval = await this.opts.host.getApproval(command.approvalId);
      if (!approval) {
        this.counters.approval_refused += 1;
        await this.notify(message.conversationKey, APPROVAL_REFUSED_NOTICE);
        return "done";
      }
      await this.opts.host.decideApproval({
        id: approval.id,
        decision: command.decision,
        senderId: message.senderId,
        ...(command.reason ? { reason: command.reason } : {}),
      });
      this.counters.approval_decided += 1;
      this.log("info", "decided an approval from Telegram", { decision: command.decision });
    } catch (error) {
      const code = errorCode(error);
      if (code === "not_found" || code === "forbidden") {
        this.counters.approval_refused += 1;
        await this.notify(message.conversationKey, APPROVAL_REFUSED_NOTICE);
      } else if (code === "invalid_transition" || code === "conflict") {
        await this.notify(message.conversationKey, APPROVAL_SETTLED_NOTICE);
      } else throw error;
    }
    return "done";
  }

  /** A notice outside the thread (refusals). Best effort: a failure is logged, never retried. */
  private async notify(chatId: string, text: string): Promise<void> {
    try {
      if (this.opts.host.admits && !(await this.opts.host.admits(chatId))) return;
      await this.opts.api.sendMessage(chatId, text, this.signal);
    } catch (error) {
      if (this.signal.aborted) return;
      this.counters.send_failed += 1;
      this.log("warn", "telegram notice not delivered", {
        status: error instanceof TelegramApiError ? error.status : 0,
      });
    }
  }

  // Outbound --------------------------------------------------------------------------------

  /** One pass at a time per thread, in seq order. Returns when this pass ends. */
  relay(threadId: string): Promise<void> {
    if (this.signal.aborted) return Promise.resolve();
    if (this.retryTimers.has(threadId)) return this.relays.get(threadId) ?? Promise.resolve();
    this.relayAgain.add(threadId);
    const existing = this.relays.get(threadId);
    if (existing) return existing;
    const next = Promise.resolve()
      .then(async () => {
        while (
          this.relayAgain.delete(threadId) &&
          !this.signal.aborted &&
          !this.retryTimers.has(threadId)
        ) {
          await this.relayPass(threadId);
        }
      })
      .catch((error: unknown) => {
        if (isStale(error) || this.signal.aborted) return;
        this.log("warn", "telegram relay failed; will retry", {
          reason: errorCode(error) ?? "internal",
        });
        this.scheduleRetry(threadId);
      })
      .finally(() => {
        this.relays.delete(threadId);
        // A frame can arrive between the last pass and this promise's cleanup microtask.
        if (this.relayAgain.has(threadId)) void this.relay(threadId);
      });
    this.relays.set(threadId, next);
    return next;
  }

  private async chatOf(threadId: string): Promise<string> {
    let chatId = this.chats.get(threadId);
    if (!chatId) {
      chatId = await this.opts.host.conversationKeyOf(threadId);
      this.chats.set(threadId, chatId);
    }
    return chatId;
  }

  private async relayPass(threadId: string): Promise<void> {
    if (this.signal.aborted || this.phase === "revoked") return;
    const { host, state, api } = this.opts;
    const cursor = state.cursor(threadId);
    await host.syncActivity?.(threadId);
    while (!this.signal.aborted) {
      const messages = await host.listMessages(threadId, cursor.relayedSeq);
      if (messages.length === 0) break;
      const before = cursor.relayedSeq;
      for (const message of messages) {
        if (this.signal.aborted) return;
        if (message.seq <= cursor.relayedSeq) continue;
        const permit = await host.beginSend({ threadId, seq: message.seq });
        if (permit.send) {
          const chunks = chunkTelegramText(renderForTelegram(message));
          const ids = cursor.sentChunkIds ?? [];
          const chatId = chunks.length > ids.length ? await this.chatOf(threadId) : "";
          let dropped = false;
          for (let i = ids.length; i < chunks.length; i += 1) {
            try {
              if (!(await host.beginSend({ threadId, seq: message.seq })).send) {
                dropped = true;
                break;
              }
              const sent = await api.sendMessage(chatId, chunks[i] as string, this.signal);
              ids.push(String(sent.message_id));
              cursor.sentChunkIds = ids;
              state.save();
              this.counters.relayed_chunks += 1;
            } catch (error) {
              if (this.signal.aborted) return;
              if (!(error instanceof TelegramApiError)) throw error;
              if (error.revoked) {
                this.setPhase("revoked", REVOKED_MESSAGE);
                this.log("warn", "telegram refused the bot token; relay stopped", {});
                return;
              }
              if (error.retryable) {
                if (error.status === 0 || error.status >= 500) {
                  cursor.uncertainDeliverySeq = message.seq;
                  state.save();
                }
                this.counters.send_deferred += 1;
                this.log("warn", "telegram is not accepting sends; keeping the message", {
                  status: error.status,
                });
                this.scheduleRetry(
                  threadId,
                  error.retryAfterSeconds !== undefined
                    ? error.retryAfterSeconds * 1000
                    : undefined,
                );
                return;
              }
              this.counters.send_failed += 1;
              cursor.failedDelivery = { seq: message.seq, status: error.status };
              state.save();
              this.log("warn", "telegram refused a thread message; dropping it", {
                status: error.status,
                chunk: i + 1,
                chunks: chunks.length,
              });
              dropped = true;
              break;
            }
          }
          if (!dropped && ids.length > 0)
            await host.recordSend({ threadId, seq: message.seq, providerMessageIds: ids });
        }
        cursor.relayedSeq = message.seq;
        cursor.sentChunkIds = undefined;
        state.save();
      }
      if (cursor.relayedSeq <= before) break;
    }
    this.retryDelays.delete(threadId);
  }

  private scheduleRetry(threadId: string, afterMs?: number): void {
    if (this.signal.aborted || this.retryTimers.has(threadId)) return;
    const { initialMs, maxMs } = this.opts.retry;
    const delay = afterMs ?? this.retryDelays.get(threadId) ?? initialMs;
    this.retryDelays.set(threadId, Math.min(Math.max(delay, initialMs) * 2, maxMs));
    const timer = setTimeout(() => {
      this.retryTimers.delete(threadId);
      void this.relay(threadId);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(threadId, timer);
  }
}
