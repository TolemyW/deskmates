import type { WAMessage } from "@whiskeysockets/baileys";
import type { SendResult } from "../whatsapp/outbound.js";
import type { InboundEvent } from "../whatsapp/webhook-payload.js";
import { phoneFromJid, reduceWebMessage } from "./messages.js";

export type WebPhase =
  | "idle"
  | "connecting"
  | "qr"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "error";
/**
 * The `name` of an error `onAccount` throws when the linked number may not be served (ADR-0047
 * amendment 1: it is connected elsewhere, or differs from this connection's number). Its message
 * is shown to the operator instead of the generic relay failure.
 */
export const ACCOUNT_REFUSED_ERROR = "WhatsAppAccountRefused";

export interface WebStatus {
  phase: WebPhase;
  account: string | null;
  qr: string | null;
  qrExpiresAt: string | null;
  error: string | null;
  reconnects: number;
  inboundFailures: number;
}
export interface SocketUpdate {
  connection?: "open" | "close";
  qr?: string;
  account?: string;
  reason?: "restart" | "logout" | "invalid" | "transient";
  code?: number;
}
export interface WebSocketHandle {
  end(): void;
  logout(): Promise<void>;
  send(to: string, text: string): Promise<string | undefined>;
  resolveLid(jid: string): Promise<string | null>;
}
export interface SocketCallbacks {
  update(update: SocketUpdate): void;
  messages(type: string, messages: WAMessage[]): void;
}
export interface WebSessionDeps {
  create(callbacks: SocketCallbacks): Promise<WebSocketHandle>;
  encodeQr(qr: string): Promise<string>;
  isOutbound(id: string): boolean;
  reset(): void;
  onAccount(account: string): Promise<void>;
  inbound(event: InboundEvent): Promise<void>;
  pause(): Promise<void>;
  retryMs?: number;
  qrLifetimeMs?: number;
}

/** One live generation; callbacks from closed or replaced sockets are inert. */
export class WebSession {
  private status: WebStatus = {
    phase: "idle",
    account: null,
    qr: null,
    qrExpiresAt: null,
    error: null,
    reconnects: 0,
    inboundFailures: 0,
  };
  private socket: WebSocketHandle | undefined;
  private generation = 0;
  private updateSequence = 0;
  private wanted = false;
  private opening: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private qrTimer: NodeJS.Timeout | undefined;
  private inboundQueue: Promise<void> = Promise.resolve();
  private logoutTask: Promise<void> | undefined;
  private queued = 0;
  private accountReady: Promise<void> | undefined;

  constructor(private readonly deps: WebSessionDeps) {}
  snapshot(): WebStatus {
    return { ...this.status };
  }

  async connect(): Promise<void> {
    if (this.logoutTask) await this.logoutTask;
    if (this.opening) return this.opening;
    if (this.socket && this.wanted) return;
    this.wanted = true;
    this.clearTimers();
    this.status.reconnects = 0;
    return this.open();
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.status = { ...this.status, phase: "connecting", qr: null, qrExpiresAt: null, error: null };
    const task = (async () => {
      try {
        const socket = await this.deps.create({
          update: (update) => {
            void this.update(generation, update);
          },
          messages: (type, messages) => this.messages(generation, type, messages),
        });
        if (!this.current(generation)) {
          socket.end();
          return;
        }
        this.socket = socket;
      } catch {
        if (this.current(generation)) this.retry(generation);
      }
    })();
    this.opening = task;
    try {
      await task;
    } finally {
      if (this.opening === task) this.opening = undefined;
    }
  }

  private current(generation: number): boolean {
    return this.wanted && generation === this.generation;
  }

  private async update(generation: number, update: SocketUpdate): Promise<void> {
    if (!this.current(generation)) return;
    const sequence = ++this.updateSequence;
    if (update.connection === "close") {
      this.socket?.end();
      this.socket = undefined;
      this.clearTimers();
      this.status.qr = null;
      this.status.qrExpiresAt = null;
      if (update.reason === "logout" || update.reason === "invalid") {
        this.wanted = false;
        ++this.generation;
        this.status.phase = "logged_out";
        this.status.account = null;
        this.status.error = update.code
          ? `WhatsApp rejected the linked-device handshake (${update.code}). Relink with a fresh QR.`
          : "The linked session ended. Log out locally, then scan a new QR.";
        await this.accountReady?.catch(() => undefined);
        await this.deps.pause();
        return;
      }
      this.retry(generation, update.reason === "restart", update.code);
      return;
    }
    if (update.connection === "open") {
      const account = phoneFromJid(update.account);
      if (!account) {
        await this.stop();
        this.status.phase = "error";
        this.status.error = "The linked account has no usable phone number.";
        return;
      }
      this.status.account = account;
      try {
        const preparing = this.deps.onAccount(account);
        this.accountReady = preparing;
        await preparing;
        if (!this.current(generation)) return;
        this.clearTimers();
        this.status = {
          ...this.status,
          phase: "connected",
          account,
          qr: null,
          qrExpiresAt: null,
          error: null,
          reconnects: 0,
        };
      } catch (error) {
        await this.stop();
        this.status.phase = "error";
        this.status.error =
          error instanceof Error && error.name === ACCOUNT_REFUSED_ERROR
            ? error.message
            : "Could not prepare the Deskmates relay.";
      } finally {
        this.accountReady = undefined;
      }
      return;
    }
    if (update.qr) {
      try {
        const image = await this.deps.encodeQr(update.qr);
        if (!this.current(generation) || sequence !== this.updateSequence) return;
        if (this.qrTimer) clearTimeout(this.qrTimer);
        const lifetime = this.deps.qrLifetimeMs ?? 60_000;
        this.status = {
          ...this.status,
          phase: "qr",
          qr: image,
          qrExpiresAt: new Date(Date.now() + lifetime).toISOString(),
          error: null,
        };
        this.qrTimer = setTimeout(() => {
          if (!this.current(generation) || sequence !== this.updateSequence) return;
          this.status.qr = null;
          this.status.qrExpiresAt = null;
          this.status.phase = "connecting";
        }, lifetime);
        this.qrTimer.unref();
      } catch {
        if (this.current(generation)) {
          this.status.phase = "error";
          this.status.error = "Could not render the QR code.";
        }
      }
    }
  }

  private retry(generation: number, immediate = false, code?: number): void {
    if (!this.current(generation) || this.retryTimer) return;
    // Fence the failed socket immediately, including messages emitted after its close event.
    ++this.generation;
    this.socket?.end();
    this.socket = undefined;
    this.status.qr = null;
    this.status.qrExpiresAt = null;
    this.status.reconnects++;
    if (this.status.reconnects > 8) {
      this.wanted = false;
      this.status.phase = "error";
      this.status.error = "Connection failed repeatedly. Check the server network and reconnect.";
      return;
    }
    this.status.phase = "reconnecting";
    this.status.error = code ? `WhatsApp connection closed (${code}); retrying.` : null;
    const delay = immediate
      ? 0
      : Math.min((this.deps.retryMs ?? 1_000) * 2 ** (this.status.reconnects - 1), 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.wanted) void this.open();
    }, delay);
    this.retryTimer.unref();
  }

  private messages(generation: number, type: string, messages: WAMessage[]): void {
    if (type !== "notify" || !this.current(generation)) return;
    for (const message of messages) {
      if (this.queued >= 500) {
        this.status.inboundFailures++;
        continue;
      }
      this.queued++;
      this.inboundQueue = this.inboundQueue
        .then(async () => {
          const socket = this.socket;
          const account = this.status.account;
          if (!socket || !account || !this.current(generation)) return;
          await this.accountReady;
          if (!this.current(generation)) return;
          const event = await reduceWebMessage(message, account, this.deps.isOutbound, (jid) =>
            socket.resolveLid(jid),
          );
          if (!event) return;
          for (let attempt = 0; attempt < 5 && this.current(generation); attempt++) {
            try {
              await this.deps.inbound(event);
              return;
            } catch {
              if (attempt === 4) {
                this.status.inboundFailures++;
                return;
              }
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(this.deps.retryMs ?? 1_000, 1_000)),
              );
            }
          }
        })
        .catch(() => {
          this.status.inboundFailures++;
        })
        .finally(() => {
          this.queued--;
        });
    }
  }

  async send(to: string, text: string): Promise<SendResult> {
    if (this.status.phase !== "connected" || !this.socket) return this.sendFailure();
    try {
      const messageId = await this.socket.send(to, text);
      return messageId ? { ok: true, messageId, attempts: 1 } : this.sendFailure();
    } catch {
      return this.sendFailure();
    }
  }
  private sendFailure(): SendResult {
    return {
      ok: false,
      status: 0,
      code: undefined,
      message: "Linked-device send not confirmed",
      attempts: 1,
      retryable: true,
    };
  }

  async stop(): Promise<void> {
    this.wanted = false;
    ++this.generation;
    this.clearTimers();
    this.socket?.end();
    this.socket = undefined;
    this.status = { ...this.status, phase: "idle", account: null, qr: null, qrExpiresAt: null };
    await this.opening;
    await this.accountReady?.catch(() => undefined);
    await this.inboundQueue;
    await this.deps.pause();
  }

  logout(): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    const task = (async () => {
      const socket = this.socket;
      this.wanted = false;
      ++this.generation;
      this.clearTimers();
      this.socket = undefined;
      this.status = {
        ...this.status,
        phase: "logged_out",
        account: null,
        qr: null,
        qrExpiresAt: null,
        error: null,
      };
      await this.opening;
      await this.accountReady?.catch(() => undefined);
      await this.inboundQueue;
      await this.deps.pause();
      try {
        await socket?.logout();
      } catch {
        this.status.error = "Local session cleared; also unlink this device on your phone.";
      } finally {
        socket?.end();
        this.deps.reset();
      }
    })();
    this.logoutTask = task;
    void task
      .finally(() => {
        this.logoutTask = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.qrTimer) clearTimeout(this.qrTimer);
    this.retryTimer = undefined;
    this.qrTimer = undefined;
  }
}
